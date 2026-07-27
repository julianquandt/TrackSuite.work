"""Instance policy: who may create an account on *this* server.

tracksuite.work runs the ``open`` profile — anyone may sign up. Self-hosters
usually want something narrower:

* **Single user** — one person syncing their own devices. No web signup at all;
  the account is created once from the terminal (``python -m app_server.cli
  create-user``)::

      WORK_TIME_SIGNUP_MODE=closed
      WORK_TIME_MAX_USERS=1

* **Team / HR** — a company instance where only staff may enrol, gated by email
  domain, a shared invite code, or both::

      WORK_TIME_SIGNUP_MODE=restricted
      WORK_TIME_SIGNUP_ALLOWED_DOMAINS=acme.com,acme.de
      WORK_TIME_SIGNUP_INVITE_CODES=<long-random-string>

Everything is environment-driven so a deployment is *configured*, never forked.
Values are read at call time (not import time) so tests and ``systemctl
set-environment`` style changes take effect without reimporting the module.
"""

from __future__ import annotations

import logging
import os
import secrets
from typing import Optional

logger = logging.getLogger("tracksuite.instance")

SIGNUP_OPEN = "open"
SIGNUP_RESTRICTED = "restricted"
SIGNUP_CLOSED = "closed"
SIGNUP_MODES = (SIGNUP_OPEN, SIGNUP_RESTRICTED, SIGNUP_CLOSED)

DEFAULT_INSTANCE_NAME = "TrackSuite.work"


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _env_list(name: str) -> list[str]:
    """Comma- or whitespace-separated env value as a clean lowercase list."""
    raw = _env(name).replace(",", " ")
    return [item.strip().lower() for item in raw.split() if item.strip()]


def instance_name() -> str:
    return _env("WORK_TIME_INSTANCE_NAME") or DEFAULT_INSTANCE_NAME


def signup_mode() -> str:
    """Configured signup mode, defaulting to ``open``.

    An unrecognised value is treated as ``closed`` rather than ``open``: a typo
    in the unit file must never silently open registration to the internet.
    """
    raw = _env("WORK_TIME_SIGNUP_MODE").lower()
    if not raw:
        return SIGNUP_OPEN
    if raw not in SIGNUP_MODES:
        logger.warning(
            "WORK_TIME_SIGNUP_MODE=%r is not one of %s — treating signup as closed.",
            raw, ", ".join(SIGNUP_MODES),
        )
        return SIGNUP_CLOSED
    return raw


def allowed_email_domains() -> list[str]:
    """Domains permitted to register, e.g. ``["acme.com"]``. Empty = any."""
    return [domain.lstrip("@") for domain in _env_list("WORK_TIME_SIGNUP_ALLOWED_DOMAINS")]


def _invite_codes() -> list[str]:
    # Case-sensitive and whitespace-split: these are secrets, not identifiers.
    raw = _env("WORK_TIME_SIGNUP_INVITE_CODES").replace(",", " ")
    return [code for code in raw.split() if code]


def invite_required() -> bool:
    return signup_mode() == SIGNUP_RESTRICTED and bool(_invite_codes())


def max_users() -> int:
    """Hard cap on accounts on this instance. 0 (default) = unlimited."""
    try:
        value = int(_env("WORK_TIME_MAX_USERS") or "0")
    except ValueError:
        logger.warning("WORK_TIME_MAX_USERS is not a number — ignoring the cap.")
        return 0
    return max(value, 0)


def _invite_code_matches(supplied: Optional[str]) -> bool:
    """Constant-time membership test against every configured invite code.

    Deliberately checks all codes without short-circuiting so response timing
    doesn't leak how many codes exist or how far a guess matched.
    """
    candidate = (supplied or "").strip()
    matched = False
    for code in _invite_codes():
        if secrets.compare_digest(candidate, code):
            matched = True
    return matched


def email_domain(email: str) -> str:
    return email.rsplit("@", 1)[-1].strip().lower() if "@" in email else ""


def signup_rejection_reason(
    email: str,
    invite_code: Optional[str] = None,
    *,
    user_count: int = 0,
    creates_new_user: bool = True,
) -> Optional[str]:
    """Why this signup is not allowed, or ``None`` if it is.

    ``creates_new_user`` is False when an existing (incomplete, data-less)
    account is being reset in place — that consumes no new seat, so the
    ``WORK_TIME_MAX_USERS`` cap must not block it.
    """
    mode = signup_mode()

    if mode == SIGNUP_CLOSED:
        return (
            "Registration is disabled on this instance. "
            "Ask the administrator to create an account for you."
        )

    if mode == SIGNUP_RESTRICTED:
        domains = allowed_email_domains()
        codes = _invite_codes()
        if not domains and not codes:
            # Fail safe, not open: 'restricted' with nothing to restrict *by*
            # would otherwise be indistinguishable from 'open'.
            logger.warning(
                "WORK_TIME_SIGNUP_MODE=restricted but neither "
                "WORK_TIME_SIGNUP_ALLOWED_DOMAINS nor WORK_TIME_SIGNUP_INVITE_CODES "
                "is set — refusing all signups."
            )
            return "Registration is not configured on this instance."
        if domains and email_domain(email) not in domains:
            allowed = ", ".join("@" + d for d in domains)
            return f"This instance only accepts addresses at {allowed}."
        if codes and not _invite_code_matches(invite_code):
            return "That invite code is not valid."

    cap = max_users()
    if cap and creates_new_user and user_count >= cap:
        return "This instance has reached its account limit."

    return None


def public_config(*, user_count: int = 0, email_enabled: bool = False,
                  tos_version: str = "") -> dict:
    """Non-secret instance description for the web app's startup fetch.

    Exposes only what the UI must render: whether to show a signup link, an
    invite-code field, and which domains to hint at. Never the invite codes.
    """
    mode = signup_mode()
    cap = max_users()
    at_capacity = bool(cap) and user_count >= cap
    return {
        "instance_name": instance_name(),
        "signup_mode": mode,
        "signup_open": mode != SIGNUP_CLOSED and not at_capacity,
        "invite_required": invite_required(),
        "allowed_email_domains": allowed_email_domains() if mode == SIGNUP_RESTRICTED else [],
        "email_enabled": email_enabled,
        "tos_version": tos_version,
    }
