"""Server-side lookup of the latest desktop release.

The download page needs the *current* installer URLs, and GitHub asset names
change every release, so they have to be resolved at runtime. Doing that from
the visitor's browser would send their IP to GitHub on every page load — the
same automatic third-party transfer we removed the Google Fonts import for, and
it would need a `connect-src` hole in the CSP besides. So the server asks
instead, once every cache window, and the browser only ever talks to us.

Deliberately dependency-free (urllib, like mailer.py) and deliberately
fail-soft: the download page has a working fallback button, so a GitHub outage
must never turn into a 500 here.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Optional

logger = logging.getLogger("work_time_server.releases")

DEFAULT_REPO = "julianquandt/TrackSuite.work"
CACHE_TTL_SECONDS = 900        # 15 minutes: releases are rare, rate limits are not
STALE_GRACE_SECONDS = 86400    # keep serving a stale copy for a day if GitHub is down
REQUEST_TIMEOUT_SECONDS = 6

_lock = threading.Lock()
_cache: Optional[dict] = None
_cached_at: float = 0.0


def repo() -> str:
    """Which repository to read releases from. Read at call time so a
    self-hoster can point this at their own fork without a code change."""
    return (os.environ.get("WORK_TIME_RELEASES_REPO") or DEFAULT_REPO).strip()


def _fetch_from_github(slug: str) -> dict:
    url = f"https://api.github.com/repos/{slug}/releases/latest"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "work-time-app-server",
        },
    )
    with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        payload = json.loads(response.read().decode("utf-8"))

    assets = []
    for asset in payload.get("assets") or []:
        name = asset.get("name")
        download_url = asset.get("browser_download_url")
        if not name or not download_url:
            continue
        # Only ever hand back github.com URLs. If the API returned something
        # else, an attacker (or a compromised account) could point the download
        # buttons at an arbitrary host.
        if not download_url.startswith("https://github.com/"):
            logger.warning("Ignoring release asset with unexpected URL: %s", download_url)
            continue
        assets.append({
            "name": name,
            "browser_download_url": download_url,
            "size": asset.get("size") or 0,
        })

    return {
        "tag_name": payload.get("tag_name") or "",
        "html_url": payload.get("html_url") or f"https://github.com/{slug}/releases/latest",
        "published_at": payload.get("published_at") or "",
        "assets": assets,
    }


def latest_release() -> Optional[dict[str, Any]]:
    """The latest release, or None if it isn't knowable right now.

    Serves from cache when fresh. On a failed refresh it keeps serving the last
    good copy for a day rather than blanking the download page over a blip.
    """
    global _cache, _cached_at

    with _lock:
        age = time.monotonic() - _cached_at
        if _cache is not None and age < CACHE_TTL_SECONDS:
            return _cache

        slug = repo()
        try:
            fresh = _fetch_from_github(slug)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
                ValueError, OSError) as exc:
            if _cache is not None and age < STALE_GRACE_SECONDS:
                logger.warning("Release lookup failed (%s) — serving cached copy.", exc)
                return _cache
            logger.warning("Release lookup failed (%s) and no usable cache.", exc)
            return None

        _cache = fresh
        _cached_at = time.monotonic()
        return fresh


def reset_cache() -> None:
    """Drop the cache. For tests."""
    global _cache, _cached_at
    with _lock:
        _cache = None
        _cached_at = 0.0
