"""Megalobiz provider — Megalobiz public lyrics API (no key needed).

The old ``www.megalobiz.com/searchall`` HTML scrape is dead: the site
was rebuilt as a Next.js app and ``/searchall`` now answers 404, with
no ``/lrc/maker/download/`` links or ``lrc_*_details`` spans anywhere
in the markup. Megalobiz now publishes a documented anonymous API
(see ``GET https://api.megalobiz.com/api/public/v1``):

- ``GET /api/public/v1/search?title=&artist=&duration=`` — scored
  results (``id``, ``title``, ``artist``, ``duration``,
  ``duration_diff``, ``sync``, ``score``);
- ``GET /api/public/v1/lrc/{id}?format=lrc`` — the LRC document.

The first result is taken (the API returns results in score order);
the result is only returned when it is line-synced LRC, as before.
Anonymous limits are 30 requests/minute and 1000/day — the chain
makes at most two requests per song, well inside them.
"""

from __future__ import annotations

from ._http import http_get_text, parse_json_lenient
from .parse import is_line_synced_lrc

NAME = "Megalobiz"
ID = "megalobiz"

_BASE_URL = "https://api.megalobiz.com/api/public/v1"


def _search(title, artist, duration_seconds):
    params = {"title": title, "artist": artist}
    if duration_seconds and duration_seconds > 0:
        params["duration"] = duration_seconds
    status, body = http_get_text(
        _BASE_URL + "/search", params=params, timeout=10.0
    )
    if not 200 <= status <= 299:
        return None
    payload = parse_json_lenient(body)
    if not isinstance(payload, dict):
        return None
    results = payload.get("results")
    if not isinstance(results, list) or not results:
        return None
    first = results[0]
    if not isinstance(first, dict):
        return None
    result_id = first.get("id")
    if result_id is None:
        return None
    return result_id


def _fetch_lrc(result_id) -> str | None:
    status, body = http_get_text(
        f"{_BASE_URL}/lrc/{result_id}",
        params={"format": "lrc"},
        timeout=10.0,
    )
    if not 200 <= status <= 299:
        return None
    cleaned = body.strip()
    if is_line_synced_lrc(cleaned):
        return cleaned
    return None


def get_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    try:
        clean_title = (title or "").strip()
        clean_artist = (artist or "").strip()
        if not clean_title or not clean_artist:
            return None
        result_id = _search(clean_title, clean_artist, duration_seconds)
        if result_id is None:
            return None
        return _fetch_lrc(result_id)
    except Exception:
        return None


def get_all_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    result = get_lyrics(video_id, title, artist, album, duration_seconds, api_key)
    return [result] if result else []
