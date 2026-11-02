"""Unison provider — port of ``Unison.kt``.

Base ``https://unison.boidu.dev/``:

- ``lyrics/search`` (``song`` / ``artist`` / ``album`` / ``duration`` /
  ``limit=5``) — each summary becomes an entry directly when it already
  carries lyrics, else it is resolved via ``lyrics?v=<videoId>`` or
  ``lyrics/<id>``;
- ``lyrics?v=<videoId>`` fallback when metadata search finds nothing;
- ``lyrics/variants/<videoId>`` for the all-results path, then the
  video-id fetch as a last resort.

Every response is a ``{"success": bool, "data": ...}`` envelope; only
``success`` payloads with non-blank lyrics count.
"""

from __future__ import annotations

from ._http import http_get_text, parse_json_lenient

NAME = "Unison"
ID = "unison"

_BASE_URL = "https://unison.boidu.dev/"
_MAX_SEARCH_RESULTS = 5


def _get_json(path, params=None) -> dict | None:
    status, body = http_get_text(_BASE_URL + path, params=params, timeout=20.0)
    if not 200 <= status <= 299:
        return None
    payload = parse_json_lenient(body)
    return payload if isinstance(payload, dict) else None


def _entry_with_lyrics(payload: dict) -> dict | None:
    if not payload.get("success"):
        return None
    data = payload.get("data")
    if not isinstance(data, dict):
        return None
    lyrics = data.get("lyrics")
    if isinstance(lyrics, str) and lyrics.strip():
        return data
    return None


def _to_entry(summary: dict) -> dict | None:
    lyrics = summary.get("lyrics")
    if isinstance(lyrics, str) and lyrics.strip():
        return summary
    return None


def _fetch_by_video_id(video_id: str) -> dict | None:
    try:
        payload = _get_json("lyrics", params={"v": video_id})
    except Exception:
        return None
    return _entry_with_lyrics(payload) if payload else None


def _fetch_by_id(entry_id) -> dict | None:
    try:
        payload = _get_json(f"lyrics/{entry_id}")
    except Exception:
        return None
    return _entry_with_lyrics(payload) if payload else None


def _search_entries(title, artist, album, duration_seconds) -> list[dict]:
    clean_title = (title or "").strip()
    clean_artist = (artist or "").strip()
    if not clean_title or not clean_artist:
        return []
    params = {"song": clean_title, "artist": clean_artist, "limit": _MAX_SEARCH_RESULTS}
    if album and str(album).strip():
        params["album"] = str(album).strip()
    if duration_seconds and duration_seconds > 0:
        params["duration"] = duration_seconds
    try:
        payload = _get_json("lyrics/search", params=params)
    except Exception:
        return []
    if not payload or not payload.get("success"):
        return []
    summaries = payload.get("data") or []
    entries = []
    for summary in summaries:
        if len(entries) >= _MAX_SEARCH_RESULTS:
            break
        if not isinstance(summary, dict):
            continue
        entry = _to_entry(summary)
        if entry is None:
            video_id = summary.get("videoId")
            if video_id and str(video_id).strip():
                entry = _fetch_by_video_id(str(video_id))
            if entry is None:
                entry = _fetch_by_id(summary.get("id"))
        if entry is not None:
            entries.append(entry)
    return entries


def _fetch_variants(video_id: str) -> list[dict]:
    try:
        payload = _get_json(f"lyrics/variants/{video_id}")
    except Exception:
        return []
    if not payload or not payload.get("success"):
        return []
    entries = []
    for summary in payload.get("data") or []:
        if isinstance(summary, dict):
            entry = _to_entry(summary)
            if entry is not None:
                entries.append(entry)
        if len(entries) >= _MAX_SEARCH_RESULTS:
            break
    return entries


def _fetch_entry(video_id, title, artist, album, duration_seconds) -> dict | None:
    clean_title = (title or "").strip()
    clean_artist = (artist or "").strip()
    if not clean_title or not clean_artist:
        return None
    entries = _search_entries(clean_title, clean_artist, album, duration_seconds)
    if entries:
        return entries[0]
    clean_video_id = (video_id or "").strip()
    if not clean_video_id:
        return None
    return _fetch_by_video_id(clean_video_id)


def get_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    try:
        entry = _fetch_entry(video_id, title, artist, album, duration_seconds)
        if entry is None:
            return None
        return entry.get("lyrics")
    except Exception:
        return None


def get_all_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    try:
        results = _search_entries(title, artist, album, duration_seconds)
        if not results:
            clean_video_id = (video_id or "").strip()
            if clean_video_id:
                results = _fetch_variants(clean_video_id)
                if not results:
                    entry = _fetch_by_video_id(clean_video_id)
                    results = [entry] if entry else []
        return [entry["lyrics"] for entry in results[:_MAX_SEARCH_RESULTS]]
    except Exception:
        return []
