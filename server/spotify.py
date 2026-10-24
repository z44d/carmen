"""
Spotify read access for the playlist converter.

Uses Spotify's *Client Credentials* flow (``SPOTIFY_CLIENT_ID`` /
``SPOTIFY_CLIENT_SECRET`` env vars), which is enough to read any **public**
playlist — no user login, no OAuth dance. Private playlists are invisible to
this flow and surface as "not found", which the routes translate into a
clear, actionable error.

Only stdlib + ``httpx`` (already a server dependency) is used.
"""

from __future__ import annotations

import base64
import logging
import os
import re
import threading
import time
from dataclasses import dataclass, field
from urllib.parse import urlparse

import httpx

log = logging.getLogger(__name__)

TOKEN_URL = "https://accounts.spotify.com/api/token"
API_BASE = "https://api.spotify.com/v1"

# open.spotify.com/playlist/<id>, with optional locale prefix and query string.
_PLAYLIST_URL_RE = re.compile(
    r"^(?:https?://)?open\.spotify\.com/(?:intl-[a-z-]+/)?playlist/([A-Za-z0-9]{22})(?:[?#/].*)?$",
    re.IGNORECASE,
)
# spotify:playlist:<id>
_PLAYLIST_URI_RE = re.compile(
    r"^spotify:playlist:([A-Za-z0-9]{22})$", re.IGNORECASE
)
# a bare 22-char base62 playlist id
_BARE_ID_RE = re.compile(r"^([A-Za-z0-9]{22})$")


class SpotifyError(Exception):
    """Base class for every Spotify failure."""


class SpotifyUrlError(SpotifyError):
    """The user did not give us a recognizable Spotify playlist link."""


class SpotifyAuthError(SpotifyError):
    """Client credentials are missing or were rejected by Spotify."""


class SpotifyNotFoundError(SpotifyError):
    """No such playlist — or it is private (invisible to this flow)."""


class SpotifyApiError(SpotifyError):
    """Any other Spotify API failure (rate limits, outages, …)."""


def parse_spotify_playlist_url(value: str) -> str:
    """
    Extract the 22-char playlist id from anything a user might paste.

    Accepts ``open.spotify.com`` links (with locale prefixes, query strings
    and fragments), ``spotify:playlist:`` URIs and bare ids. Raises
    :class:`SpotifyUrlError` for everything else.
    """
    text = (value or "").strip()
    if not text:
        raise SpotifyUrlError("Paste a Spotify playlist link first.")
    for pattern in (_PLAYLIST_URI_RE, _PLAYLIST_URL_RE, _BARE_ID_RE):
        match = pattern.match(text)
        if match:
            return match.group(1)
    # Last chance: the user pasted a URL with extra path junk we don't
    # recognize — try to find a /playlist/<id> segment anywhere in it.
    try:
        path = urlparse(text).path or ""
    except Exception:  # noqa: BLE001
        path = ""
    loose = re.search(r"/playlist/([A-Za-z0-9]{22})(?:[?#/]|$)", path)
    if loose:
        return loose.group(1)
    raise SpotifyUrlError(
        "That doesn't look like a Spotify playlist link. "
        "Open the playlist in Spotify, tap Share → Copy link, and paste it here."
    )


def spotify_configured() -> bool:
    """True when both Spotify client credentials are present."""
    return bool(os.environ.get("SPOTIFY_CLIENT_ID") and os.environ.get("SPOTIFY_CLIENT_SECRET"))


@dataclass
class SpotifyTrack:
    """One playable track of a Spotify playlist, normalized for matching."""

    id: str
    title: str
    artists: list[str] = field(default_factory=list)
    album: str = ""
    album_artwork: str | None = None
    duration_ms: int = 0
    isrc: str | None = None
    spotify_url: str = ""
    explicit: bool = False

    @property
    def artist_display(self) -> str:
        return ", ".join(self.artists) if self.artists else "Unknown artist"


@dataclass
class SpotifyPlaylist:
    """Playlist metadata + every playable track (paginated through)."""

    id: str
    name: str
    description: str = ""
    owner: str = ""
    artwork: str | None = None
    spotify_url: str = ""
    tracks: list[SpotifyTrack] = field(default_factory=list)

    @property
    def track_count(self) -> int:
        return len(self.tracks)


class SpotifyClient:
    """
    Minimal Spotify Web API client (client-credentials flow).

    The access token is cached in-memory and refreshed a minute before it
    expires; a lock keeps concurrent first-requests from minting two tokens.
    """

    def __init__(
        self,
        client_id: str | None = None,
        client_secret: str | None = None,
        http: httpx.Client | None = None,
        timeout: float = 15.0,
    ) -> None:
        self.client_id = client_id or os.environ.get("SPOTIFY_CLIENT_ID", "")
        self.client_secret = client_secret or os.environ.get("SPOTIFY_CLIENT_SECRET", "")
        self._http = http or httpx.Client(timeout=timeout)
        self._owns_http = http is None
        self._token: str | None = None
        self._token_expires_at: float = 0.0
        self._lock = threading.Lock()

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    # ── auth ────────────────────────────────────────────────────────────

    def _fetch_token(self) -> tuple[str, float]:
        if not self.client_id or not self.client_secret:
            raise SpotifyAuthError(
                "Spotify import isn't configured on this server — set "
                "SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET and restart it."
            )
        basic = base64.b64encode(f"{self.client_id}:{self.client_secret}".encode()).decode()
        try:
            response = self._http.post(
                TOKEN_URL,
                data={"grant_type": "client_credentials"},
                headers={"Authorization": f"Basic {basic}"},
            )
        except httpx.HTTPError as exc:
            raise SpotifyApiError(f"Could not reach Spotify: {exc}") from exc
        if response.status_code in (400, 401):
            raise SpotifyAuthError(
                "Spotify rejected the client credentials — check "
                "SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET."
            )
        if response.status_code == 429:
            raise SpotifyApiError("Spotify is rate-limiting us — try again in a minute.")
        if response.status_code >= 400:
            raise SpotifyApiError(f"Spotify token request failed ({response.status_code}).")
        payload = response.json()
        token = payload.get("access_token")
        if not token:
            raise SpotifyApiError("Spotify didn't return an access token.")
        expires_in = float(payload.get("expires_in", 3600))
        return token, time.time() + expires_in

    def _token_header(self) -> dict[str, str]:
        with self._lock:
            if not self._token or time.time() > self._token_expires_at - 60:
                self._token, self._token_expires_at = self._fetch_token()
            return {"Authorization": f"Bearer {self._token}"}

    # ── api ─────────────────────────────────────────────────────────────

    def _get(self, path: str, params: dict | None = None) -> dict:
        try:
            response = self._http.get(
                f"{API_BASE}{path}", params=params, headers=self._token_header()
            )
        except httpx.HTTPError as exc:
            raise SpotifyApiError(f"Could not reach Spotify: {exc}") from exc
        if response.status_code == 404:
            raise SpotifyNotFoundError(
                "Spotify couldn't find that playlist — it may be private, "
                "deleted, or the link is wrong."
            )
        if response.status_code == 429:
            retry = response.headers.get("Retry-After", "60")
            raise SpotifyApiError(
                f"Spotify is rate-limiting us — try again in {retry}s."
            )
        if response.status_code >= 400:
            raise SpotifyApiError(f"Spotify request failed ({response.status_code}).")
        return response.json()

    @staticmethod
    def _largest_image(images: list | None) -> str | None:
        if not images:
            return None
        best = max(images, key=lambda img: (img.get("height") or 0) * (img.get("width") or 0))
        return best.get("url")

    @classmethod
    def _track_from_item(cls, item: dict) -> SpotifyTrack | None:
        track = item.get("track") if isinstance(item, dict) else None
        if not isinstance(track, dict):
            return None
        if track.get("is_local"):
            return None  # local files have no Spotify metadata to match on
        track_id = track.get("id")
        title = (track.get("name") or "").strip()
        if not track_id or not title:
            return None
        artists = [
            (artist.get("name") or "").strip()
            for artist in track.get("artists", [])
            if isinstance(artist, dict) and artist.get("name")
        ]
        album = track.get("album") or {}
        external_ids = track.get("external_ids") or {}
        external_urls = track.get("external_urls") or {}
        return SpotifyTrack(
            id=track_id,
            title=title,
            artists=artists,
            album=(album.get("name") or "").strip(),
            album_artwork=cls._largest_image(album.get("images")),
            duration_ms=int(track.get("duration_ms") or 0),
            isrc=external_ids.get("isrc"),
            spotify_url=external_urls.get("spotify", ""),
            explicit=bool(track.get("explicit")),
        )

    def get_playlist(self, playlist_id: str, market: str = "US") -> SpotifyPlaylist:
        """
        Fetch playlist metadata plus **every** playable track.

        Spotify pages tracks at 100 per request; we follow the pages until
        they run out.
        """
        data = self._get(
            f"/playlists/{playlist_id}",
            params={
                "market": market,
                "fields": "id,name,description,owner(display_name),images,external_urls,tracks(total)",
            },
        )
        owner = data.get("owner") or {}
        external_urls = data.get("external_urls") or {}
        playlist = SpotifyPlaylist(
            id=data.get("id", playlist_id),
            name=data.get("name") or "Spotify playlist",
            description=(data.get("description") or "").strip(),
            owner=(owner.get("display_name") or "").strip(),
            artwork=self._largest_image(data.get("images")),
            spotify_url=external_urls.get("spotify", ""),
        )

        limit = 100
        offset = 0
        while True:
            page = self._get(
                f"/playlists/{playlist_id}/tracks",
                params={
                    "market": market,
                    "limit": limit,
                    "offset": offset,
                    "fields": (
                        "next,items(track(id,name,artists(name),album(name,images),"
                        "duration_ms,explicit,is_local,external_ids(isrc),"
                        "external_urls(spotify)))"
                    ),
                },
            )
            items = page.get("items") or []
            for item in items:
                track = self._track_from_item(item)
                if track:
                    playlist.tracks.append(track)
            if not page.get("next") or not items:
                break
            offset += limit
        return playlist
