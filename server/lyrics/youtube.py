"""YouTube providers.

YouTube Subtitle is intentionally unavailable: on Android,
``YouTubeSubtitleLyricsProvider`` calls
``YTPlayerUtils.ensureWebPoTokensForSubtitles(id)`` and then
``YouTube.transcript(id, authState)`` — fetching a transcript needs
the Innertube web-client PoToken auth state that only the signed-in
Android player session holds (minted by BotGuard). That auth state
does not exist server-side or in a browser, and the auth-free
``video.google.com/timedtext`` endpoint returns nothing for these
videos (verified empty for the Adele test video), so the subtitle
provider always returns ``None`` and is marked unavailable. A
yt-dlp subtitle extraction was investigated and rejected: in the
sandbox it stalled for 50s at the webpage-fetch stage without
producing a subtitle file, far beyond the chain's 8s per-provider
budget, and it cannot be verified without the production
``browser.json`` cookies.

YouTube Music IS a real chain provider. It reuses exactly the
YouTube Music lyrics path ``server/core.py`` already uses as a
fallback in ``_collect_lyrics``: the bare mobile Innertube ``browse``
request (``_browse_mobile``) returns line timestamps, and
``ytmusicapi``'s plain ``get_lyrics`` supplies the unsynced text.
Timed lines are serialised to LRC so the chain parser handles them
like every other provider; when only plain text exists it is
returned as-is (quality 0).

The provider needs the lyrics browse id (``MPLYt…``). The chain
runner threads it through as ``browse_id``; when the chain is run
without one (the picker endpoint), the provider resolves it from
the video id via the watch playlist, exactly as ``get_track`` does.
All imports from ``server/core.py`` are deferred inside the
function so there is no import cycle (``core`` imports this package
lazily, and this module must never import ``core`` at module level).
"""

from __future__ import annotations

SUBTITLE_NAME = "YouTube Subtitle"
SUBTITLE_ID = "youtube-subtitle"
MUSIC_NAME = "YouTube Music"
MUSIC_ID = "youtube-music"


def _format_lrc_time(time_ms: int) -> str:
    total_seconds, millis = divmod(max(int(time_ms), 0), 1000)
    minutes, seconds = divmod(total_seconds, 60)
    return f"[{minutes:02d}:{seconds:02d}.{millis // 10:02d}]"


def _timed_lines_to_lrc(lines) -> str | None:
    """Serialise parsed timed lines to LRC; ``None`` when there are none."""
    timed = [line for line in lines or [] if str(line.get("text") or "").strip()]
    if not timed:
        return None
    return "\n".join(
        f"{_format_lrc_time(line['timeMs'])}{line['text'].strip()}"
        for line in timed
    )


def _music_lyrics_for_browse_id(browse_id: str) -> str | None:
    """YouTube Music lyrics for one lyrics browse id, or ``None``."""
    from ..core import (
        _TIMED_LYRICS_PATH,
        _browse_mobile,
        _dig,
        _find_timed_lines,
        _parse_timed_lines,
        get_lyrics as _ytmusic_lyrics,
    )

    payload = _browse_mobile(browse_id)
    if isinstance(payload, dict):
        data = _dig(payload, _TIMED_LYRICS_PATH)
        raw_lines = data.get("timedLyricsData") if isinstance(data, dict) else None
        if not isinstance(raw_lines, list) or not raw_lines:
            raw_lines = _find_timed_lines(payload)
        if isinstance(raw_lines, list) and raw_lines:
            lrc = _timed_lines_to_lrc(_parse_timed_lines(raw_lines))
            if lrc:
                return lrc
    try:
        plain = _ytmusic_lyrics(browse_id, timestamps=False)
    except Exception:
        plain = None
    if plain:
        text = plain.get("lyrics")
        if isinstance(text, str) and text.strip():
            return text
    return None


def _resolve_browse_id(video_id: str) -> str | None:
    """Lyrics browse id for a video id, via the watch playlist."""
    from ..core import ytm

    if ytm is None:
        return None
    try:
        watch = ytm.get_watch_playlist(videoId=video_id, limit=5) or {}
    except Exception:
        return None
    browse_id = watch.get("lyrics")
    return browse_id if isinstance(browse_id, str) and browse_id else None


def get_subtitle_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    # Needs Innertube PoToken auth state (YTPlayerUtils on Android,
    # minted by BotGuard); unavailable server-side. See module docstring.
    return None


def get_subtitle_all_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    return []


def get_music_lyrics(
    video_id, title, artist, album, duration_seconds, api_key=None, browse_id=None
):
    """YouTube Music lyrics: timed LRC, or plain text, or ``None``."""
    try:
        resolved = browse_id
        if not resolved and video_id:
            resolved = _resolve_browse_id(str(video_id).strip())
        if not resolved:
            return None
        return _music_lyrics_for_browse_id(resolved)
    except Exception:
        return None


def get_music_all_lyrics(
    video_id, title, artist, album, duration_seconds, api_key=None, browse_id=None
):
    result = get_music_lyrics(
        video_id, title, artist, album, duration_seconds, api_key, browse_id=browse_id
    )
    return [result] if result else []
