"""LrcLib provider — port of ``LrcLib.kt`` + ``models/Track.kt``.

``GET https://lrclib.net/api/search`` with ``track_name`` / ``artist_name``
/ ``album_name``. Only tracks with usable (non-blank) synced or plain
lyrics are considered.

Best match: with a known duration, the closest duration within 2 seconds
wins; with an unknown duration (``-1``), the similarity-scored match wins
— average title/artist similarity (contains counts 0.8, otherwise
1 − levenshtein/max-length, best of the two) must exceed 0.6, with +0.1
for synced lyrics. ``getAll`` sorts by synced/plain bonus + similarity
(unknown duration) or by duration distance, keeps only matches within
2 seconds, emits at most 5 results, and emits plain lyrics at most once.
"""

from __future__ import annotations

from ._http import http_get_json

NAME = "LrcLib"
ID = "lrclib"

_MAX_SEARCH_RESULTS = 5
_MAX_DURATION_DELTA_SECONDS = 2
_SEARCH_URL = "https://lrclib.net/api/search"


def _usable(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _query_lyrics(title, artist, album):
    params = {"track_name": title, "artist_name": artist}
    if album:
        params["album_name"] = album
    payload = http_get_json(_SEARCH_URL, params=params, timeout=15.0)
    if not isinstance(payload, list):
        return []
    tracks = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        track = {
            "trackName": item.get("trackName") or "",
            "artistName": item.get("artistName") or "",
            "duration": item.get("duration") or 0,
            "plainLyrics": item.get("plainLyrics"),
            "syncedLyrics": item.get("syncedLyrics"),
        }
        if _usable(track["syncedLyrics"]) or _usable(track["plainLyrics"]):
            tracks.append(track)
    return tracks


def _levenshtein(s1: str, s2: str) -> int:
    len1, len2 = len(s1), len(s2)
    matrix = [[0] * (len2 + 1) for _ in range(len1 + 1)]
    for i in range(len1 + 1):
        matrix[i][0] = i
    for j in range(len2 + 1):
        matrix[0][j] = j
    for i in range(1, len1 + 1):
        for j in range(1, len2 + 1):
            cost = 0 if s1[i - 1] == s2[j - 1] else 1
            matrix[i][j] = min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost,
            )
    return matrix[len1][len2]


def _similarity(str1: str, str2: str) -> float:
    """Track.kt's calculateSimilarity: max(contains 0.8, levenshtein)."""
    s1, s2 = str1.strip().lower(), str2.strip().lower()
    if s1 == s2:
        return 1.0
    if not s1 or not s2:
        return 0.0
    contains_score = 0.8 if (s1 in s2 or s2 in s1) else 0.0
    max_length = max(len(s1), len(s2))
    distance_score = 1.0 - (_levenshtein(s1, s2) / max_length)
    return max(contains_score, distance_score)


def _lrclib_similarity(str1: str, str2: str) -> float:
    """LrcLib.kt's calculateStringSimilarity: contains short-circuits."""
    s1, s2 = str1.strip().lower(), str2.strip().lower()
    if s1 == s2:
        return 1.0
    if not s1 or not s2:
        return 0.0
    if s1 in s2 or s2 in s1:
        return 0.8
    max_length = max(len(s1), len(s2))
    return 1.0 - (_levenshtein(s1, s2) / max_length)


def _find_best_match(tracks, title, artist):
    best = None
    best_score = None
    for track in tracks:
        score = (
            _similarity(title, track["trackName"])
            + _similarity(artist, track["artistName"])
        ) / 2.0
        if track["syncedLyrics"] is not None:
            score += 0.1
        if best_score is None or score > best_score:
            best, best_score = track, score
    if best is None:
        return None
    average = (
        _similarity(title, best["trackName"])
        + _similarity(artist, best["artistName"])
    ) / 2.0
    return best if average > 0.6 else None


def _best_matching_for(tracks, duration, title=None, artist=None):
    if not tracks:
        return None
    if duration == -1:
        if title is not None and artist is not None:
            return _find_best_match(tracks, title, artist)
        for track in tracks:
            if track["syncedLyrics"] is not None:
                return track
        return tracks[0]
    best = min(tracks, key=lambda t: abs(int(t["duration"]) - duration))
    if abs(int(best["duration"]) - duration) <= 2:
        return best
    return None


def _preferred_lyrics(track) -> str | None:
    if _usable(track["syncedLyrics"]):
        return track["syncedLyrics"]
    if _usable(track["plainLyrics"]):
        return track["plainLyrics"]
    return None


def _matches_duration(track, duration) -> bool:
    return duration == -1 or abs(int(track["duration"]) - duration) <= _MAX_DURATION_DELTA_SECONDS


def get_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    duration = -1 if duration_seconds is None else int(duration_seconds)
    try:
        tracks = _query_lyrics(title, artist, album)
        if duration == -1:
            track = _best_matching_for(tracks, duration, title, artist)
        else:
            track = _best_matching_for(tracks, duration)
        lyrics = _preferred_lyrics(track) if track else None
        return lyrics
    except Exception:
        return None


def get_all_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    duration = -1 if duration_seconds is None else int(duration_seconds)
    try:
        tracks = _query_lyrics(title, artist, album)
    except Exception:
        return []
    if duration == -1:
        def sort_key(track):
            score = 0.0
            if _usable(track["syncedLyrics"]):
                score += 1.0
            if _usable(track["plainLyrics"]):
                score += 0.25
            score += (
                _lrclib_similarity(title, track["trackName"])
                + _lrclib_similarity(artist, track["artistName"])
            ) / 2.0
            return score

        sorted_tracks = sorted(tracks, key=sort_key, reverse=True)
    else:
        sorted_tracks = sorted(
            tracks, key=lambda t: abs(int(t["duration"]) - duration)
        )
    results = []
    count = 0
    emitted_plain = False
    for track in sorted_tracks:
        if count >= _MAX_SEARCH_RESULTS:
            break
        if not _matches_duration(track, duration):
            continue
        synced = track["syncedLyrics"]
        if synced and synced.strip():
            results.append(synced)
            count += 1
        if not emitted_plain and count < _MAX_SEARCH_RESULTS:
            plain = track["plainLyrics"]
            if plain and plain.strip():
                results.append(plain)
                count += 1
                emitted_plain = True
    return results
