"""Lyrics provider registry — the Android default order.

Mirrors ``LyricsHelper.baseProviders`` exactly. Each entry carries the
provider id, its display name, the module implementing the
``LyricsProvider`` interface (``get_lyrics`` / ``get_all_lyrics``), and
whether it needs a Paxsenix API key. The unused ``Paxsenix (Auto)``
provider is NOT in this registry: it is not in
``LyricsHelper.baseProviders`` either.

YouTube providers are registered but never available server-side (see
``youtube.py``); Paxsenix providers are available only when a key is
supplied with the request.
"""

from __future__ import annotations

from . import (
    betterlyrics,
    kugou,
    lrclib,
    megalobiz,
    paxsenix,
    simpmusic,
    unison,
    youlyplus,
    youtube,
)

# (id, display name, module, get_lyrics, get_all_lyrics, requires_key, always_unavailable)
_PROVIDERS = [
    (
        "betterlyrics",
        "BetterLyrics",
        betterlyrics,
        betterlyrics.get_lyrics,
        betterlyrics.get_all_lyrics,
        False,
        False,
    ),
    (
        "betterlyrics-portato",
        "BetterLyrics Portato",
        betterlyrics,
        betterlyrics.get_portato_lyrics,
        betterlyrics.get_portato_all_lyrics,
        False,
        False,
    ),
    (
        "youlyplus",
        "YouLyPlus",
        youlyplus,
        youlyplus.get_lyrics,
        youlyplus.get_all_lyrics,
        False,
        False,
    ),
    (
        "lrclib",
        "LrcLib",
        lrclib,
        lrclib.get_lyrics,
        lrclib.get_all_lyrics,
        False,
        False,
    ),
    (
        "kugou",
        "Kugou",
        kugou,
        kugou.get_lyrics,
        kugou.get_all_lyrics,
        False,
        False,
    ),
    (
        "megalobiz",
        "Megalobiz",
        megalobiz,
        megalobiz.get_lyrics,
        megalobiz.get_all_lyrics,
        False,
        False,
    ),
    (
        "simpmusic",
        "SimpMusic",
        simpmusic,
        simpmusic.get_lyrics,
        simpmusic.get_all_lyrics,
        False,
        False,
    ),
    (
        "unison",
        "Unison",
        unison,
        unison.get_lyrics,
        unison.get_all_lyrics,
        False,
        False,
    ),
    (
        "paxsenix-apple-music",
        "Paxsenix: Apple Music",
        paxsenix,
        paxsenix.get_lyrics_apple_music,
        paxsenix.get_all_apple_music,
        True,
        False,
    ),
    (
        "paxsenix-spotify",
        "Paxsenix: Spotify",
        paxsenix,
        paxsenix.get_lyrics_spotify,
        paxsenix.get_all_spotify,
        True,
        False,
    ),
    (
        "paxsenix-musixmatch",
        "Paxsenix: Musixmatch",
        paxsenix,
        paxsenix.get_lyrics_musixmatch,
        paxsenix.get_all_musixmatch,
        True,
        False,
    ),
    (
        "youtube-subtitle",
        "YouTube Subtitle",
        youtube,
        youtube.get_lyrics,
        youtube.get_all_lyrics,
        False,
        True,
    ),
    (
        "youtube-music",
        "YouTube Music",
        youtube,
        youtube.get_lyrics,
        youtube.get_all_lyrics,
        False,
        True,
    ),
]

PROVIDER_IDS = [entry[0] for entry in _PROVIDERS]
PROVIDER_NAMES = {entry[0]: entry[1] for entry in _PROVIDERS}

_BY_ID = {entry[0]: entry for entry in _PROVIDERS}


def get_entry(provider_id: str):
    """Registry entry tuple for *provider_id*, or ``None``."""
    return _BY_ID.get(provider_id)


def get_name(provider_id: str) -> str | None:
    entry = _BY_ID.get(provider_id)
    return entry[1] if entry else None


def is_known(provider_id: str) -> bool:
    return provider_id in _BY_ID


def is_available(provider_id: str, api_key: str | None = None) -> bool:
    """Whether the provider can run for this request.

    YouTube providers are never available server-side; Paxsenix providers
    need a non-blank key; everything else is always available.
    """
    entry = _BY_ID.get(provider_id)
    if entry is None:
        return False
    if entry[6]:
        return False
    if entry[5]:
        return bool(api_key and str(api_key).strip())
    return True


def default_order() -> list[str]:
    return list(PROVIDER_IDS)


def resolve_order(
    lyrics_order: list[str] | None, lyrics_enabled: set[str] | None
) -> list[str]:
    """Providers to consult, in order.

    ``lyrics_order`` (when given) is the exact order and the exact set;
    otherwise the registry default order applies. ``lyrics_enabled``
    filters either way. Unknown ids are dropped here — routes validate
    them separately and answer 400.
    """
    order = list(lyrics_order) if lyrics_order else default_order()
    order = [pid for pid in order if pid in _BY_ID]
    if lyrics_enabled is not None:
        order = [pid for pid in order if pid in lyrics_enabled]
    return order


def call_get_lyrics(provider_id, video_id, title, artist, album, duration_seconds, api_key=None):
    entry = _BY_ID[provider_id]
    return entry[3](video_id, title, artist, album, duration_seconds, api_key)


def call_get_all_lyrics(provider_id, video_id, title, artist, album, duration_seconds, api_key=None):
    entry = _BY_ID[provider_id]
    return entry[4](video_id, title, artist, album, duration_seconds, api_key)
