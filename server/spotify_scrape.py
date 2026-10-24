"""
Zero-setup Spotify playlist reader.

Reads a playlist's public embed page (``open.spotify.com/embed/playlist/<id>``),
which ships the track list as embedded JSON — no ``SPOTIFY_CLIENT_ID`` /
``SPOTIFY_CLIENT_SECRET`` needed. The official API client
(``server/spotify.py``) is preferred whenever credentials are configured
(full pagination, higher rate limits); this is the fallback that makes the
feature work out of the box.

Caveats: private/deleted playlists have no public embed page (surfaced as
not-found), very long playlists may be truncated to what the embed ships,
and the page structure can change — the parser fails loudly
(``SpotifyApiError``) instead of returning garbage.
"""

import json
import re

import httpx

from .spotify import (
    SpotifyApiError,
    SpotifyNotFoundError,
    SpotifyPlaylist,
    SpotifyTrack,
    parse_spotify_playlist_url,
)

EMBED_URL = "https://open.spotify.com/embed/playlist/{playlist_id}"
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
_NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
    re.DOTALL,
)


def _track_id(uri: str) -> str:
    """``spotify:track:<id>`` -> ``<id>`` (falls back to the raw value)."""
    return uri.rsplit(":", 1)[-1] if uri else ""


def parse_embed_html(html: str, playlist_id: str) -> SpotifyPlaylist:
    """
    Build a :class:`SpotifyPlaylist` from an embed page's HTML.

    Raises :class:`SpotifyApiError` when the embedded payload is missing or
    has an unexpected shape, so callers never silently convert half a page.
    """
    match = _NEXT_DATA_RE.search(html)
    if not match:
        raise SpotifyApiError(
            "Spotify changed its public page layout — the playlist data "
            "couldn't be read. Configure SPOTIFY_CLIENT_ID / "
            "SPOTIFY_CLIENT_SECRET for the official API instead."
        )
    try:
        payload = json.loads(match.group(1))
        entity = payload["props"]["pageProps"]["state"]["data"]["entity"]
        raw_tracks = entity["trackList"]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise SpotifyApiError(
            "Spotify changed its public page layout — the playlist data "
            "couldn't be read. Configure SPOTIFY_CLIENT_ID / "
            "SPOTIFY_CLIENT_SECRET for the official API instead."
        ) from exc

    sources = (entity.get("coverArt") or {}).get("sources") or []
    tracks: list[SpotifyTrack] = []
    for raw in raw_tracks:
        if not isinstance(raw, dict) or raw.get("entityType") != "track":
            continue
        uri = str(raw.get("uri") or "")
        track_id = _track_id(uri)
        if not track_id:
            continue
        artist = str(raw.get("subtitle") or "").strip()
        tracks.append(
            SpotifyTrack(
                id=track_id,
                title=str(raw.get("title") or "Unknown title").strip(),
                artists=[artist] if artist else [],
                duration_ms=int(raw.get("duration") or 0),
                spotify_url=f"https://open.spotify.com/track/{track_id}",
                explicit=bool(raw.get("isExplicit")),
            )
        )

    description = ""
    for attr in entity.get("attributes") or []:
        if isinstance(attr, dict) and attr.get("key") == "description":
            description = str(attr.get("value") or "")
            break

    return SpotifyPlaylist(
        id=playlist_id,
        name=str(entity.get("title") or "Spotify playlist").strip(),
        description=description,
        owner=str(entity.get("subtitle") or "").strip(),
        artwork=sources[0].get("url") if sources else None,
        spotify_url=f"https://open.spotify.com/playlist/{playlist_id}",
        tracks=tracks,
    )


class ScrapedSpotifyClient:
    """
    Drop-in replacement for :class:`SpotifyClient` that needs no credentials.

    Same ``get_playlist(playlist_id)`` contract, same ``Spotify*`` errors, so
    the convert routes don't care which client served the playlist.
    """

    def __init__(self, http: httpx.Client | None = None, timeout: float = 15.0) -> None:
        # The UA rides on the request (not the client) so a caller-supplied
        # httpx.Client keeps its own headers untouched.
        self._http = http or httpx.Client(timeout=timeout)
        self._owns_http = http is None

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    def get_playlist(self, playlist_id: str) -> SpotifyPlaylist:
        try:
            response = self._http.get(
                EMBED_URL.format(playlist_id=playlist_id),
                headers={"User-Agent": BROWSER_UA},
            )
        except httpx.HTTPError as exc:
            raise SpotifyApiError(f"Couldn't reach Spotify: {exc}") from exc
        if response.status_code == 404:
            raise SpotifyNotFoundError(
                "Spotify couldn't find that playlist — it may be private, "
                "deleted, or the link is wrong."
            )
        if response.status_code != 200:
            raise SpotifyApiError(
                f"Spotify answered with HTTP {response.status_code} while "
                "reading the playlist page."
            )
        return parse_embed_html(response.text, playlist_id)


def resolve_playlist_id(url: str) -> str:
    """Parse any accepted Spotify playlist reference to its bare id."""
    return parse_spotify_playlist_url(url)
