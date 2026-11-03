"""BetterLyrics provider — port of ``BetterLyrics.kt``.

Endpoints (base ``https://lyrics-api.boidu.dev/``), params ``s`` (title),
``a`` (artist), ``al`` (album, when non-blank), ``d`` (duration seconds,
when > 0):

- ``getLyrics`` then ``kugou/getLyrics`` (BetterLyrics)
- ``qq/getLyrics`` only (BetterLyrics Portato)

Responses are TTML or QRC documents, or JSON envelopes unwrapped up
to two levels deep through the ``ttml`` / ``lyrics`` / ``data`` /
``result`` / ``response`` keys, carrying an optional ``score`` — exactly
as in Kotlin, except QRC payloads are accepted as content: the
``qq/getLyrics`` endpoint returns QRC inside the ``lyrics`` key, and
the chain parser handles QRC natively (see ``_qrc.py``). A plain-text
(non-TTML, non-QRC, non-JSON) body decodes to nothing, as in Kotlin.
"""

from __future__ import annotations

import re

from ._http import http_get_text, parse_json_lenient
from ._qrc import is_qrc

NAME = "BetterLyrics"
ID = "betterlyrics"
PORTATO_NAME = "BetterLyrics Portato"
PORTATO_ID = "betterlyrics-portato"

_BASE_URL = "https://lyrics-api.boidu.dev/"
_TTML_ROOT_RE = re.compile(r"<(?:[A-Za-z_][\w.-]*:)?tt(?:\s|>)", re.IGNORECASE)
_MAX_TTML_ROOT_SCAN_LENGTH = 4096
_MAX_RESPONSE_UNWRAP_DEPTH = 2


def _is_ttml_payload(value: str) -> bool:
    return _TTML_ROOT_RE.search(value[:_MAX_TTML_ROOT_SCAN_LENGTH]) is not None


def _is_qrc_payload(value: str) -> bool:
    """Whether *value* is itself a QRC document (not a JSON envelope).

    The ``qq/getLyrics`` (Portato) endpoint returns QRC inside the
    ``lyrics`` envelope key; QRC is a first-class lyric format for the
    chain parser (see ``_qrc.py``), so a QRC payload is valid content
    exactly like a TTML one. The raw-envelope check is gated on the
    text starting with ``<``: a JSON envelope merely *contains* the
    QRC markers inside its escaped string, and must still go through
    the unwrap branch so the parser receives the QRC text itself,
    not the JSON.
    """
    stripped = value.lstrip()
    return stripped.startswith("<") and is_qrc(value)


def _decode_lyrics(response_text: str):
    """Return ``(content, score)`` or ``None``, mirroring decodeLyrics."""
    raw = response_text.removeprefix("\ufeff")
    if _is_ttml_payload(raw):
        return raw, None
    if _is_qrc_payload(raw):
        return raw, None
    root = parse_json_lenient(response_text)
    if root is None:
        return None
    score = None
    if isinstance(root, dict):
        ttml_value = root.get("ttml", root.get("lyrics", ""))
        if isinstance(ttml_value, str) and (
            _is_ttml_payload(ttml_value) or is_qrc(ttml_value)
        ):
            score = root.get("score")
            if isinstance(score, (int, float)):
                return ttml_value, float(score)
            return ttml_value, None
    nested = _decode_element(root, depth=0)
    if nested is None:
        return None
    content, nested_score = nested
    return content, score if score is not None else nested_score


def _decode_element(element, depth: int):
    if depth > _MAX_RESPONSE_UNWRAP_DEPTH:
        return None
    if isinstance(element, dict):
        score = element.get("score")
        score = float(score) if isinstance(score, (int, float)) else None
        payload = None
        for key in ("ttml", "lyrics", "data", "result", "response"):
            if key in element:
                payload = element[key]
                break
        if payload is None:
            return None
        decoded = _decode_element(payload, depth + 1)
        if decoded is None:
            return None
        content, nested_score = decoded
        return content, score if score is not None else nested_score
    if isinstance(element, str):
        if _is_ttml_payload(element) or is_qrc(element):
            return element, None
        if depth < _MAX_RESPONSE_UNWRAP_DEPTH:
            nested = parse_json_lenient(element)
            if nested is None:
                return None
            return _decode_element(nested, depth + 1)
        return None
    return None


def _fetch_from_endpoint(endpoint, title, artist, album, duration_seconds):
    params = {"s": title, "a": artist}
    if album:
        params["al"] = album
    if duration_seconds and duration_seconds > 0:
        params["d"] = duration_seconds
    status, text = http_get_text(_BASE_URL + endpoint, params=params, timeout=20.0)
    if not 200 <= status <= 299:
        return None
    decoded = _decode_lyrics(text)
    if decoded is None:
        return None
    content, _score = decoded
    return content if content.strip() else None


def _fetch(title, artist, album, duration_seconds, endpoints) -> str | None:
    clean_title = (title or "").strip()
    clean_artist = (artist or "").strip()
    clean_album = (album or "").strip()
    if not clean_title or not clean_artist:
        return None
    for endpoint in endpoints:
        try:
            lyrics = _fetch_from_endpoint(
                endpoint, clean_title, clean_artist, clean_album, duration_seconds
            )
        except Exception:
            lyrics = None
        if lyrics:
            return lyrics
    return None


def get_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    try:
        return _fetch(
            title, artist, album, duration_seconds,
            ["getLyrics", "kugou/getLyrics"],
        )
    except Exception:
        return None


def get_all_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    result = get_lyrics(video_id, title, artist, album, duration_seconds, api_key)
    return [result] if result else []


# ── Portato variant (same API, qq/getLyrics only) ─────────────────────────


def get_portato_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    try:
        return _fetch(title, artist, album, duration_seconds, ["qq/getLyrics"])
    except Exception:
        return None


def get_portato_all_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    result = get_portato_lyrics(
        video_id, title, artist, album, duration_seconds, api_key
    )
    return [result] if result else []
