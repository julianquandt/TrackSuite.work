"""Outgoing transactional email via Resend (https://resend.com).

Uses the stdlib HTTP client (no extra dependency) and sends on a small
background thread pool so a slow provider never blocks a request. If
RESEND_API_KEY is unset the module is a no-op — dev and tests run without email,
and email-gated features degrade gracefully rather than erroring.
"""

import json
import logging
import os
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

logger = logging.getLogger("tracksuite.mail")
# Attach our own handler so mail INFO/WARNING always surface in journald,
# regardless of uvicorn's root-logger configuration.
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    logger.addHandler(_handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False

RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
# e.g. "TrackSuite.work <noreply@mail.tracksuite-work.julianquandt.com>"
MAIL_FROM = os.environ.get("WORK_TIME_MAIL_FROM", "TrackSuite.work <onboarding@resend.dev>")
# Base URL of the web app, used to build links in emails (no trailing slash).
PUBLIC_BASE_URL = os.environ.get("WORK_TIME_PUBLIC_BASE_URL", "").rstrip("/")
RESEND_ENDPOINT = "https://api.resend.com/emails"

_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="mail")


def mail_enabled() -> bool:
    return bool(RESEND_API_KEY)


# Announce configuration at import so it's obvious in the logs whether email is
# on and which sender it uses (helps diagnose "no email was sent").
logger.info(
    "mailer configured: enabled=%s from=%r base_url=%r",
    mail_enabled(), MAIL_FROM if mail_enabled() else "(disabled)", PUBLIC_BASE_URL,
)


def _post(payload: dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        RESEND_ENDPOINT,
        data=body,
        headers={
            "Authorization": f"Bearer {RESEND_API_KEY}",
            "Content-Type": "application/json",
            # Resend's API is behind Cloudflare, whose bot protection blocks the
            # default "Python-urllib/x" user agent with error 1010. A normal UA
            # passes the browser-integrity check.
            "User-Agent": "TrackSuite.work-mailer/1.0 (+https://tracksuite.work)",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status >= 300:
                logger.warning("resend non-2xx status=%s", resp.status)
            else:
                logger.info("resend accepted (status=%s)", resp.status)
    except urllib.error.HTTPError as exc:
        # Include Resend's error body — it states the actual reason (e.g. domain
        # not verified, restricted recipient) and doesn't contain the message body.
        try:
            reason = exc.read().decode("utf-8", "replace")[:400]
        except Exception:
            reason = ""
        logger.warning("resend rejected: HTTP %s — %s", exc.code, reason)
    except Exception as exc:  # network/DNS/timeout
        logger.warning("resend send failed: %s: %s", type(exc).__name__, exc)


def send_email(to: str, subject: str, html: str, text: Optional[str] = None) -> None:
    """Queue an email for delivery (fire-and-forget). No-op if unconfigured."""
    if not mail_enabled():
        logger.info("mail disabled; skipping send subject=%r", subject)
        return
    payload = {"from": MAIL_FROM, "to": [to], "subject": subject, "html": html}
    if text:
        payload["text"] = text
    _executor.submit(_post, payload)


# ── Message templates ────────────────────────────────────────────────

def _link(path: str) -> str:
    return f"{PUBLIC_BASE_URL}{path}" if PUBLIC_BASE_URL else path


def _wrap(title: str, body_html: str) -> str:
    return (
        f'<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;'
        f'max-width:520px;margin:auto;color:#111">'
        f'<h2 style="margin:0 0 16px">{title}</h2>{body_html}'
        f'<hr style="border:none;border-top:1px solid #eee;margin:24px 0">'
        f'<p style="color:#888;font-size:12px">TrackSuite.work — you received this because '
        f'someone used this address on TrackSuite.work. If that wasn\'t you, you can ignore it.</p></div>'
    )


def send_verification_email(to: str, token: str) -> None:
    url = _link(f"/#/verify-email?token={token}")
    html = _wrap(
        "Confirm your email",
        f'<p>Confirm this address to finish setting up your TrackSuite.work account.</p>'
        f'<p><a href="{url}" style="background:#2563eb;color:#fff;padding:10px 18px;'
        f'border-radius:6px;text-decoration:none;display:inline-block">Verify email</a></p>'
        f'<p style="font-size:13px;color:#555">Or paste this link:<br>{url}</p>'
        f'<p style="font-size:13px;color:#555">This link expires in 24 hours.</p>',
    )
    text = f"Verify your TrackSuite.work email: {url}\nThis link expires in 24 hours."
    send_email(to, "Verify your TrackSuite.work email", html, text)


def send_already_registered_email(to: str) -> None:
    """Sent instead of a verification email when someone tries to register an
    address that already has an account — so registration doesn't confirm or
    deny existence to the requester."""
    html = _wrap(
        "You already have an account",
        f'<p>Someone tried to register a new TrackSuite.work account with this email, '
        f'but one already exists. If that was you, just <a href="{_link("/#/login")}">sign in</a>. '
        f'If not, you can safely ignore this message — no account was created or changed.</p>',
    )
    send_email(to, "You already have a TrackSuite.work account", html)


def send_password_reset_email(to: str, token: str) -> None:
    url = _link(f"/#/reset-password?token={token}")
    html = _wrap(
        "Reset your password",
        f'<p>We received a request to reset your TrackSuite.work password. Click below '
        f'to choose a new one — you\'ll still need your authenticator or a recovery code.</p>'
        f'<p><a href="{url}" style="background:#2563eb;color:#fff;padding:10px 18px;'
        f'border-radius:6px;text-decoration:none;display:inline-block">Reset password</a></p>'
        f'<p style="font-size:13px;color:#555">Or paste this link:<br>{url}</p>'
        f'<p style="font-size:13px;color:#555">This link expires in 1 hour. If you didn\'t '
        f'request this, you can ignore it — nothing has changed.</p>',
    )
    text = f"Reset your TrackSuite.work password: {url}\nExpires in 1 hour."
    send_email(to, "Reset your TrackSuite.work password", html, text)


def send_password_changed_email(to: str) -> None:
    html = _wrap(
        "Your password was changed",
        '<p>Your TrackSuite.work password was just changed and all other sessions were '
        'signed out. If this wasn\'t you, reset access immediately using your recovery '
        'codes and contact the administrator.</p>',
    )
    send_email(to, "Your TrackSuite.work password was changed", html)


def send_account_deleted_email(to: str) -> None:
    html = _wrap(
        "Your account was deleted",
        '<p>Your TrackSuite.work account and all associated data have been permanently '
        'deleted at your request. This cannot be undone. Thank you for using TrackSuite.work.</p>',
    )
    send_email(to, "Your TrackSuite.work account was deleted", html)


def send_inactivity_warning_email(to: str, days_until_deletion: int) -> None:
    html = _wrap(
        "Your account is scheduled for deletion",
        f'<p>Your TrackSuite.work account has been inactive for a long time and is '
        f'scheduled to be deleted in <strong>{days_until_deletion} days</strong> under our '
        f'data-retention policy. Simply <a href="{_link("/#/login")}">sign in</a> to keep it. '
        f'Export your data first if you want a copy.</p>',
    )
    send_email(to, "Your TrackSuite.work account will be deleted soon", html)


def send_security_alert_email(to: str, subject: str, message_html: str) -> None:
    """Generic security/breach-notification channel (Art. 34)."""
    send_email(to, subject, _wrap("Security notice", message_html))
