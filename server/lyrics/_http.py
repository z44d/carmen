"""Shared synchronous HTTP helpers for the lyrics providers.

Everything here runs inside a worker thread (the route executor / the
chain's pool), never on the event loop. ``httpx`` honours the sandbox /
deployment proxy environment variables by default, so no proxy handling
is needed here. Any transport or decoding failure raises, and each
provider converts that into a ``None`` result — one provider failing must
never break the chain.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

log = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 15.0


def http_get_text(
    url: str,
    params: dict | None = None,
    headers: dict | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> tuple[int, str]:
    """GET *url*; returns ``(status, body)``. Raises on transport errors."""
    response = httpx.get(
        url,
        params={k: v for k, v in (params or {}).items() if v is not None},
        headers=headers,
        timeout=timeout,
        follow_redirects=True,
    )
    return response.status_code, response.text


def http_get_json(
    url: str,
    params: dict | None = None,
    headers: dict | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> Any:
    """GET *url* and decode its JSON body; ``None`` on non-2xx / bad JSON."""
    status, text = http_get_text(url, params=params, headers=headers, timeout=timeout)
    if not 200 <= status <= 299:
        return None
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return None


def parse_json_lenient(text: str) -> Any:
    """Decode JSON, returning ``None`` instead of raising."""
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return None
