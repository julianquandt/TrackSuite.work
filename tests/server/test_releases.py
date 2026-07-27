"""Tests for the server-side release lookup behind the download page.

The point of the proxy is that the visitor's browser never talks to GitHub, so
these tests care about three things: the shape handed to the frontend, that a
GitHub outage degrades instead of erroring, and that only github.com URLs can
ever reach a download button.
"""

import json
import urllib.error
from contextlib import contextmanager

import pytest

from backend.app_server import releases

from .test_api import client


def _payload(**overrides):
    payload = {
        "tag_name": "v0.9.3",
        "html_url": "https://github.com/julianquandt/TrackSuite.work/releases/tag/v0.9.3",
        "published_at": "2026-07-20T10:00:00Z",
        "assets": [
            {
                "name": "TrackSuite_0.9.3_amd64.deb",
                "browser_download_url": "https://github.com/x/y/releases/download/v0.9.3/a.deb",
                "size": 1234,
            },
        ],
    }
    payload.update(overrides)
    return payload


@contextmanager
def _response(payload):
    class _Fake:
        def read(self):
            return json.dumps(payload).encode("utf-8")

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    yield _Fake()


@pytest.fixture(autouse=True)
def _clear_cache(monkeypatch):
    monkeypatch.delenv("WORK_TIME_RELEASES_REPO", raising=False)
    releases.reset_cache()
    yield
    releases.reset_cache()


def _stub_github(monkeypatch, payload, counter=None):
    def fake_urlopen(request, timeout=None):
        if counter is not None:
            counter.append(request.full_url)
        return _response(payload).__enter__()

    monkeypatch.setattr(releases.urllib.request, "urlopen", fake_urlopen)


def _stub_failure(monkeypatch):
    def fake_urlopen(request, timeout=None):
        raise urllib.error.URLError("no network")

    monkeypatch.setattr(releases.urllib.request, "urlopen", fake_urlopen)


# ── Happy path ───────────────────────────────────────────────────────

def test_endpoint_returns_the_installer_list(monkeypatch):
    _stub_github(monkeypatch, _payload())

    res = client.get("/meta/releases/latest")
    assert res.status_code == 200
    body = res.json()
    assert body["tag_name"] == "v0.9.3"
    assert len(body["assets"]) == 1
    assert body["assets"][0]["name"] == "TrackSuite_0.9.3_amd64.deb"
    assert body["assets"][0]["size"] == 1234


def test_repeated_requests_hit_github_once(monkeypatch):
    """One server-side call serves every visitor — that is the whole point of
    proxying, since the anonymous GitHub rate limit is per IP."""
    calls = []
    _stub_github(monkeypatch, _payload(), counter=calls)

    for _ in range(5):
        assert client.get("/meta/releases/latest").status_code == 200
    assert len(calls) == 1


def test_repo_is_configurable(monkeypatch):
    calls = []
    monkeypatch.setenv("WORK_TIME_RELEASES_REPO", "someone/their-fork")
    _stub_github(monkeypatch, _payload(), counter=calls)

    assert client.get("/meta/releases/latest").status_code == 200
    assert calls == ["https://api.github.com/repos/someone/their-fork/releases/latest"]


# ── Degradation ──────────────────────────────────────────────────────

def test_outage_without_a_cache_is_a_soft_503(monkeypatch):
    _stub_failure(monkeypatch)
    res = client.get("/meta/releases/latest")
    assert res.status_code == 503
    assert "temporarily unavailable" in res.json()["detail"]


def test_outage_keeps_serving_the_last_good_copy(monkeypatch):
    _stub_github(monkeypatch, _payload())
    assert client.get("/meta/releases/latest").status_code == 200

    # Force the cache stale, then break GitHub.
    monkeypatch.setattr(releases, "CACHE_TTL_SECONDS", 0)
    _stub_failure(monkeypatch)

    res = client.get("/meta/releases/latest")
    assert res.status_code == 200
    assert res.json()["tag_name"] == "v0.9.3"


# ── Only github.com URLs may reach a download button ─────────────────

def test_assets_hosted_elsewhere_are_dropped(monkeypatch):
    _stub_github(monkeypatch, _payload(assets=[
        {"name": "good.deb",
         "browser_download_url": "https://github.com/x/y/releases/download/v1/good.deb",
         "size": 1},
        {"name": "evil.deb",
         "browser_download_url": "https://evil.example.com/evil.deb",
         "size": 2},
        {"name": "no-url.deb", "browser_download_url": None, "size": 3},
    ]))

    body = client.get("/meta/releases/latest").json()
    assert [a["name"] for a in body["assets"]] == ["good.deb"]


def test_malformed_payload_does_not_raise(monkeypatch):
    _stub_github(monkeypatch, {"tag_name": None, "assets": None})
    res = client.get("/meta/releases/latest")
    assert res.status_code == 200
    assert res.json()["assets"] == []
    assert res.json()["tag_name"] == ""
