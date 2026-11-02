"""YouTube providers — intentionally unavailable on the server.

On Android, ``YouTubeSubtitleLyricsProvider`` calls
``YTPlayerUtils.ensureWebPoTokensForSubtitles(id)`` and then
``YouTube.transcript(id, authState)``: fetching a transcript needs the
Innertube web-client PoToken auth state that only the signed-in Android
player session holds. ``YouTubeLyricsProvider`` walks the authenticated
Innertube ``next`` / lyrics endpoints for the same session.

Neither auth state exists server-side, so both providers always return
``None`` here and are marked ``available=False`` in the registry. YouTube
coverage remains via the existing ``_browse_mobile`` / ``get_lyrics``
fallbacks in ``server/core.py``.
"""

from __future__ import annotations

SUBTITLE_NAME = "YouTube Subtitle"
SUBTITLE_ID = "youtube-subtitle"
MUSIC_NAME = "YouTube Music"
MUSIC_ID = "youtube-music"


def get_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    # Needs Innertube PoToken auth state (YTPlayerUtils on Android);
    # unavailable server-side. See module docstring.
    return None


def get_all_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    return []
