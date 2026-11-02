"""YouLyPlus provider — port of ``YouLyPlus.kt``.

Five mirror base URLs are tried in order. ``v1/ttml/get`` is tried first
(TTML document directly, or a ``{"ttml": ...}`` envelope); then
``v2/lyrics/get`` (``{"type", "lyrics": [{time, duration, text,
syllabus}]}``), converted to LRC: word-type responses with syllables get
inline ``<mm:ss.mmm>`` word timings, other timed lines get a bracketed
line timestamp, and untimed lines fall back to plain text.
"""

from __future__ import annotations

from ._http import http_get_text, parse_json_lenient

NAME = "YouLyPlus"
ID = "youlyplus"

_TTML_PATH = "v1/ttml/get"
_LYRICS_PATH = "v2/lyrics/get"
_BASE_URLS = [
    "https://lyricsplus.binimum.org/",
    "https://lyricsplus.prjktla.my.id/",
    "https://lyricsplus.prjktla.workers.dev/",
    "https://lyricsplus.atomix.one/",
    "https://lyricsplus-seven.vercel.app/",
]
_HEADERS = {"Accept": "application/json", "User-Agent": "Carmen"}


def _format_lrc_timestamp(time_ms: int, bracketed: bool) -> str:
    safe = max(0, int(time_ms))
    minutes, remainder = divmod(safe, 60000)
    seconds, millis = divmod(remainder, 1000)
    timestamp = f"{minutes:02d}:{seconds:02d}.{millis:03d}"
    return f"[{timestamp}]" if bracketed else f"<{timestamp}>"


def _lyrics_to_text(response: dict) -> str | None:
    lyrics = response.get("lyrics") or []
    if not lyrics:
        return None
    timed = [line for line in lyrics if isinstance(line, dict) and line.get("time") is not None]
    if timed:
        out_lines = []
        for line in timed:
            parts = [_format_lrc_timestamp(line["time"], bracketed=True)]
            syllables = [
                s
                for s in (line.get("syllabus") or [])
                if isinstance(s, dict)
                and s.get("text")
                and s.get("time") is not None
            ]
            if str(response.get("type") or "").lower() == "word" and syllables:
                for syllable in syllables:
                    parts.append(_format_lrc_timestamp(syllable["time"], bracketed=False))
                    parts.append(syllable["text"] or "")
            else:
                parts.append(line.get("text") or "")
            out_lines.append("".join(parts))
        text = "\n".join(out_lines)
        return text if text.strip() else None
    text = "\n".join(
        str(line.get("text") or "").strip()
        for line in lyrics
        if isinstance(line, dict) and str(line.get("text") or "").strip()
    )
    return text or None


def _fetch_from_mirrors(path, title, artist, album, duration_seconds, decode) -> str | None:
    params = {"title": title, "artist": artist}
    if album:
        params["album"] = album
    if duration_seconds and duration_seconds > 0:
        params["duration"] = duration_seconds
    for base_url in _BASE_URLS:
        try:
            status, body = http_get_text(
                base_url + path, params=params, headers=_HEADERS, timeout=20.0
            )
        except Exception:
            continue
        if not 200 <= status <= 299:
            continue
        try:
            lyrics = decode(body)
        except Exception:
            continue
        if lyrics and lyrics.strip():
            return lyrics
    return None


def _fetch_ttml(title, artist, album, duration_seconds) -> str | None:
    def decode(body: str) -> str | None:
        trimmed = body.strip()
        if trimmed.startswith("<"):
            candidate = trimmed
        else:
            parsed = parse_json_lenient(body)
            candidate = (
                (parsed.get("ttml") or "").strip()
                if isinstance(parsed, dict)
                else None
            )
        if candidate and candidate.startswith("<"):
            return candidate
        return None

    return _fetch_from_mirrors(
        _TTML_PATH, title, artist, album, duration_seconds, decode
    )


def _fetch_lyrics_as_lrc(title, artist, album, duration_seconds) -> str | None:
    def decode(body: str) -> str | None:
        parsed = parse_json_lenient(body)
        if not isinstance(parsed, dict):
            return None
        return _lyrics_to_text(parsed)

    return _fetch_from_mirrors(
        _LYRICS_PATH, title, artist, album, duration_seconds, decode
    )


def get_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    clean_title = (title or "").strip()
    clean_artist = (artist or "").strip()
    clean_album = (album or "").strip()
    if not clean_title or not clean_artist:
        return None
    try:
        return (
            _fetch_ttml(clean_title, clean_artist, clean_album, duration_seconds)
            or _fetch_lyrics_as_lrc(
                clean_title, clean_artist, clean_album, duration_seconds
            )
        )
    except Exception:
        return None


def get_all_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    result = get_lyrics(video_id, title, artist, album, duration_seconds, api_key)
    return [result] if result else []
