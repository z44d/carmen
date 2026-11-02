"""SimpMusic provider — port of ``SimpMusicLyrics.kt``.

``GET https://api-lyrics.simpmusic.org/v1/{videoId}``; only a
``{"type": "success", "data": [...]}`` payload counts. Single-result
picks the closest duration when more than one track matches (synced
preferred over plain); ``getAll`` emits synced tracks within 5 seconds
of the requested duration (max ~5) plus at most one plain track.
"""

from __future__ import annotations

from ._http import http_get_text, parse_json_lenient

NAME = "SimpMusic"
ID = "simpmusic"

_BASE_URL = "https://api-lyrics.simpmusic.org/v1/"
_HEADERS = {
    "Accept": "application/json",
    "User-Agent": "SimpMusicLyrics/1.0",
    "Content-Type": "application/json",
}


def _tracks_by_video_id(video_id: str) -> list[dict]:
    if not video_id:
        return []
    status, body = http_get_text(
        _BASE_URL + video_id, headers=_HEADERS, timeout=15.0
    )
    if status != 200:
        return []
    payload = parse_json_lenient(body)
    if not isinstance(payload, dict) or payload.get("type") != "success":
        return []
    data = payload.get("data") or []
    return [item for item in data if isinstance(item, dict)]


def _duration(track: dict) -> int:
    return track.get("durationSeconds") or 0


def get_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    duration = 0 if duration_seconds is None else int(duration_seconds)
    try:
        tracks = _tracks_by_video_id(video_id or "")
        if not tracks:
            return None
        if duration > 0 and len(tracks) > 1:
            best = min(tracks, key=lambda t: abs(_duration(t) - duration))
        else:
            best = tracks[0]
        synced = best.get("syncedLyrics")
        return synced if synced is not None else best.get("plainLyric")
    except Exception:
        return None


def get_all_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    duration = 0 if duration_seconds is None else int(duration_seconds)
    try:
        tracks = _tracks_by_video_id(video_id or "")
    except Exception:
        return []
    if duration > 0:
        sorted_tracks = sorted(tracks, key=lambda t: abs(_duration(t) - duration))
    else:
        sorted_tracks = tracks
    results = []
    count = 0
    plain = 0
    for track in sorted_tracks:
        if count <= 4:
            synced = track.get("syncedLyrics")
            if synced is not None and abs(_duration(track) - duration) <= 5:
                count += 1
                results.append(synced)
            plain_lyrics = track.get("plainLyric")
            if (
                plain_lyrics is not None
                and abs(_duration(track) - duration) <= 5
                and plain == 0
            ):
                count += 1
                plain += 1
                results.append(plain_lyrics)
    return results
