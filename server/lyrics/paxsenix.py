"""Paxsenix providers — port of ``PaxsenixLyrics.kt``.

Base ``https://api.paxsenix.org/``, ``Authorization: Bearer <key>``,
``User-Agent: Carmen``. All three providers are gated on the API key:
an empty/missing key means the provider is skipped entirely (it never
issues a request).

- Apple Music: ``apple-music/search?q=`` then ``lyrics/applemusic?id=``,
  with the Apple Music timed-lines payload converted to LRC.
- Spotify: ``spotify/search?q=`` then ``lyrics/spotify?id=``.
- Musixmatch: ``lyrics/musixmatch?t=&a=&d=`` directly.

Search candidates are scored exactly as in Kotlin (title exact 20 /
partial 10, artist exact 15 / partial 5, duration <3s +10 / <10s +5,
minimum total 10). Lyrics payloads are extracted via ``parseLyrics`` /
``extractLyrics``: the Apple Music shape first, then the
``lyrics`` / ``lrc`` / ``content`` / ``lines`` / ``text`` /
``plainLyrics`` / ``syncedLyrics`` / ``line`` / ``lyric`` keys (plus
``metadata.*`` and ``words``), with error payloads rejected.

The unused ``Paxsenix (Auto)`` provider (``lyrics/lrcget``) is
deliberately NOT ported: it is not in ``LyricsHelper.baseProviders``.
"""

from __future__ import annotations

from ._http import http_get_text, parse_json_lenient

_BASE_URL = "https://api.paxsenix.org/"
_MINIMUM_MATCH_SCORE = 10
_TRACK_ID_KEYS = ("id", "trackId", "track_id", "realId")
_TRACK_TITLE_KEYS = ("name", "title", "trackName", "track_name")
_TRACK_ARTIST_KEYS = ("artistName", "artist_name")
_TRACK_DURATION_KEYS = ("durationInMillis", "durationMs", "duration_ms", "duration")
_LYRICS_CONTENT_KEYS = (
    "lyrics",
    "lrc",
    "content",
    "lines",
    "text",
    "plainLyrics",
    "syncedLyrics",
    "line",
    "lyric",
)

APPLE_MUSIC_NAME = "Paxsenix: Apple Music"
APPLE_MUSIC_ID = "paxsenix-apple-music"
SPOTIFY_NAME = "Paxsenix: Spotify"
SPOTIFY_ID = "paxsenix-spotify"
MUSIXMATCH_NAME = "Paxsenix: Musixmatch"
MUSIXMATCH_ID = "paxsenix-musixmatch"


def _headers(api_key: str) -> dict:
    return {
        "User-Agent": "Carmen",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Authorization": f"Bearer {api_key}",
    }


def _api_body(path: str, api_key: str, params: dict | None = None) -> str:
    status, body = http_get_text(
        _BASE_URL + path, params=params, headers=_headers(api_key), timeout=15.0
    )
    if not 200 <= status <= 299:
        raise RuntimeError(f"Paxsenix request failed with HTTP {status}")
    return body


# ── Lyrics extraction (parseLyrics / extractLyrics) ────────────────────────


def _is_error_payload(obj: dict) -> bool:
    is_error = obj.get("isError")
    if isinstance(is_error, bool) and is_error:
        return True
    ok = obj.get("ok")
    if isinstance(ok, bool) and not ok:
        return True
    error = obj.get("error")
    if error is None:
        return False
    if isinstance(error, bool):
        return error
    if isinstance(error, str):
        return bool(error.strip())
    if isinstance(error, list):
        return len(error) > 0
    if isinstance(error, dict):
        return len(error) > 0
    return False


def _extract_lyrics(element) -> str | None:
    if element is None:
        return None
    if isinstance(element, bool):
        return None
    if isinstance(element, (int, float)):
        return None
    if isinstance(element, str):
        value = element.strip()
        if not value:
            return None
        nested = parse_json_lenient(value)
        if nested is not None and not isinstance(nested, (str, int, float, bool)):
            return _extract_lyrics(nested)
        return value
    if isinstance(element, list):
        joined = "\n".join(
            part for part in (_extract_lyrics(item) for item in element) if part
        ).strip()
        return joined or None
    if isinstance(element, dict):
        if _is_error_payload(element):
            return None
        for key in _LYRICS_CONTENT_KEYS:
            if key in element:
                found = _extract_lyrics(element[key])
                if found is not None:
                    return found
        metadata = element.get("metadata")
        if isinstance(metadata, dict):
            for key in _LYRICS_CONTENT_KEYS:
                if key in metadata:
                    found = _extract_lyrics(metadata[key])
                    if found is not None:
                        return found
        words = element.get("words")
        if words is not None:
            if isinstance(words, list):
                joined = " ".join(
                    part for part in (_extract_lyrics(item) for item in words) if part
                ).strip()
                return joined or None
            return _extract_lyrics(words)
        return None
    return None


def _clean_json_lyrics(raw: str) -> str | None:
    trimmed = raw.strip()
    if not trimmed:
        return None
    payload = parse_json_lenient(trimmed)
    if payload is None:
        return trimmed
    return _extract_lyrics(payload)


def _convert_apple_music_to_lrc(response: dict) -> str:
    lines = []
    for line in response.get("content") or []:
        if not isinstance(line, dict):
            continue
        timestamp = line.get("timestamp") or 0
        minutes = timestamp // 1000 // 60
        seconds = (timestamp // 1000) % 60
        hundredths = (timestamp % 1000) // 10
        time = f"[{minutes:02d}:{seconds:02d}.{hundredths:02d}]"
        words = line.get("text") or []
        text = " ".join(
            str(word.get("text", "")).strip()
            for word in words
            if isinstance(word, dict)
        )
        lines.append(f"{time}{text}")
    return "\n".join(lines)


def _parse_lyrics(raw: str) -> str | None:
    payload = parse_json_lenient(raw)
    if isinstance(payload, dict):
        content = payload.get("content")
        if isinstance(content, list) and content:
            converted = _convert_apple_music_to_lrc(payload)
            if converted.strip():
                return converted
    return _clean_json_lyrics(raw)


# ── Track search (searchTrackId) ───────────────────────────────────────────


def _first_string(obj: dict, keys) -> str | None:
    for key in keys:
        value = obj.get(key)
        if isinstance(value, bool) or value is None:
            continue
        if isinstance(value, (str, int, float)):
            text = str(value).strip()
            if text:
                return text
    return None


def _first_long(obj: dict, keys) -> int | None:
    for key in keys:
        value = obj.get(key)
        if isinstance(value, bool) or value is None:
            continue
        if isinstance(value, (int, float)):
            return int(value)
        if isinstance(value, str):
            try:
                return int(value.strip())
            except ValueError:
                continue
    return None


def _artist_names(obj: dict) -> str | None:
    artists = obj.get("artists", obj.get("artist"))
    if artists is None:
        return None
    if isinstance(artists, str):
        return artists
    if isinstance(artists, dict):
        return _first_string(artists, ("name", "artistName", "title"))
    if isinstance(artists, list):
        names = []
        for artist in artists:
            if isinstance(artist, str):
                names.append(artist)
            elif isinstance(artist, dict):
                name = _first_string(artist, ("name", "artistName", "title"))
                if name:
                    names.append(name)
        joined = ", ".join(names)
        return joined or None
    return None


def _to_duration_ms(value: int | None) -> int:
    if value is None or value <= 0:
        return 0
    if value < 10_000:
        return value * 1000
    return value


def _to_track_candidate(obj: dict) -> dict | None:
    attributes = obj.get("attributes")
    details = attributes if isinstance(attributes, dict) else obj
    candidate_id = _first_string(obj, _TRACK_ID_KEYS) or _first_string(
        details, _TRACK_ID_KEYS
    )
    if candidate_id is None:
        return None
    title = _first_string(details, _TRACK_TITLE_KEYS)
    if title is None:
        return None
    artist = _first_string(details, _TRACK_ARTIST_KEYS) or _artist_names(details)
    duration = _to_duration_ms(_first_long(details, _TRACK_DURATION_KEYS))
    return {
        "id": candidate_id,
        "title": title,
        "artist": artist or "",
        "durationMs": duration,
    }


def _collect_candidates(element, destination: list) -> None:
    if isinstance(element, list):
        for item in element:
            _collect_candidates(item, destination)
    elif isinstance(element, dict):
        candidate = _to_track_candidate(element)
        if candidate is not None:
            destination.append(candidate)
        for value in element.values():
            _collect_candidates(value, destination)


def _text_match_score(candidate, requested, exact_score, partial_score) -> int:
    if not candidate.strip() or not requested.strip():
        return 0
    if candidate.lower() == requested.lower():
        return exact_score
    if candidate.lower() in requested.lower() or requested.lower() in candidate.lower():
        return partial_score
    return 0


def _score(candidate, title, artist, duration_ms) -> int:
    score = _text_match_score(candidate["title"], title, 20, 10)
    score += _text_match_score(candidate["artist"], artist, 15, 5)
    if duration_ms > 0 and candidate["durationMs"] > 0:
        difference = abs(candidate["durationMs"] - duration_ms)
        if difference < 3000:
            score += 10
        elif difference < 10000:
            score += 5
    return score


def _search_track_id(path, title, artist, duration_ms, api_key) -> str | None:
    raw = _api_body(path, api_key, params={"q": f"{title} {artist}"})
    payload = parse_json_lenient(raw)
    candidates: list[dict] = []
    if payload is not None:
        _collect_candidates(payload, candidates)
    best = None
    best_score = None
    for candidate in candidates:
        score = _score(candidate, title, artist, duration_ms)
        if best_score is None or score > best_score:
            best, best_score = candidate, score
    if best is not None and best_score is not None and best_score >= _MINIMUM_MATCH_SCORE:
        return best["id"]
    return None


# ── Provider entry points ──────────────────────────────────────────────────


def _require_key(api_key) -> str | None:
    if api_key is None:
        return None
    key = str(api_key).strip()
    return key or None


def _resolve_duration_ms(duration_seconds) -> int:
    duration = 0 if duration_seconds is None else int(duration_seconds)
    return max(0, duration) * 1000


def get_apple_music_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    key = _require_key(api_key)
    if key is None:
        return None
    try:
        song_id = _search_track_id(
            "apple-music/search",
            title,
            artist,
            _resolve_duration_ms(duration_seconds),
            key,
        )
        if song_id is None:
            return None
        raw = _api_body("lyrics/applemusic", key, params={"id": song_id})
        return _parse_lyrics(raw)
    except Exception:
        return None


def get_spotify_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    key = _require_key(api_key)
    if key is None:
        return None
    try:
        track_id = _search_track_id(
            "spotify/search",
            title,
            artist,
            _resolve_duration_ms(duration_seconds),
            key,
        )
        if track_id is None:
            return None
        raw = _api_body("lyrics/spotify", key, params={"id": track_id})
        return _parse_lyrics(raw)
    except Exception:
        return None


def get_musixmatch_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    key = _require_key(api_key)
    if key is None:
        return None
    try:
        duration = -1 if duration_seconds is None else int(duration_seconds)
        raw = _api_body(
            "lyrics/musixmatch",
            key,
            params={"t": title, "a": artist, "d": str(duration)},
        )
        return _parse_lyrics(raw)
    except Exception:
        return None


def _wrap(getter):
    def get_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
        result = getter(video_id, title, artist, album, duration_seconds, api_key)
        return result if result and result.strip() else None

    def get_all_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
        result = get_lyrics(video_id, title, artist, album, duration_seconds, api_key)
        return [result] if result else []

    return get_lyrics, get_all_lyrics


get_lyrics_apple_music, get_all_apple_music = _wrap(get_apple_music_lyrics)
get_lyrics_spotify, get_all_spotify = _wrap(get_spotify_lyrics)
get_lyrics_musixmatch, get_all_musixmatch = _wrap(get_musixmatch_lyrics)
