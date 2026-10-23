"""
Spotify → YouTube Music converter routes.

- ``GET /convert/spotify/playlist`` — resolve a Spotify playlist link into
  metadata + its full track list (fast; powers the import preview).
- ``POST /convert/spotify/to-ytmusic`` — convert every track to its best
  YouTube Music match, streamed as **server-sent events** so the client can
  render honest per-track progress instead of a fake spinner:

      event: start     {"total": 87, "playlist": {...}}
      event: progress  {"done": 3, "total": 87, "result": {...}}
      event: done      {"summary": {"matched": 80, ...}}

Each ``result`` carries the Spotify track, the match ``status``
(``matched`` / ``approximate`` / ``not_found`` / ``error``), a 0–1
``confidence``, and the raw YouTube Music item (sanitized exactly like
every other payload that leaves this API) so the client can reuse its
normal track pipeline to save the converted playlist.

Requires ``SPOTIFY_CLIENT_ID`` / ``SPOTIFY_CLIENT_SECRET`` on the server
for the official API (Client Credentials flow — public playlists only).
Without them the routes transparently read Spotify's public embed page
instead, so the feature works with zero setup. Everything else is
unchanged: this router is purely additive.
"""

import asyncio
import json
from functools import partial

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from starlette.responses import StreamingResponse

from .. import matching
from ..cache import cached
from ..core import search
from ..sanitizers import sanitize, sanitized
from ..spotify import (
    SpotifyApiError,
    SpotifyAuthError,
    SpotifyClient,
    SpotifyError,
    SpotifyNotFoundError,
    SpotifyPlaylist,
    SpotifyTrack,
    SpotifyUrlError,
    parse_spotify_playlist_url,
    spotify_configured,
)
from ..spotify_scrape import ScrapedSpotifyClient
from ..state import executor

router = APIRouter(prefix="/convert", tags=["Convert"])

MAX_CONVERT_TRACKS = 200
_SEARCH_CONCURRENCY = 4


class ConvertRequest(BaseModel):
    """Body of ``POST /convert/spotify/to-ytmusic``."""

    url: str = Field(..., description="Spotify playlist link, URI or id")
    limit: int = Field(
        100, ge=1, le=MAX_CONVERT_TRACKS, description="Max tracks to convert"
    )


def _spotify_error(exc: SpotifyError) -> HTTPException:
    if isinstance(exc, SpotifyUrlError):
        return HTTPException(status_code=400, detail=str(exc))
    if isinstance(exc, SpotifyAuthError):
        # 503, not 500: the server is (temporarily) unable to do this.
        return HTTPException(status_code=503, detail=str(exc))
    if isinstance(exc, SpotifyNotFoundError):
        return HTTPException(status_code=404, detail=str(exc))
    return HTTPException(status_code=502, detail=str(exc))


def _spotify_client() -> SpotifyClient | ScrapedSpotifyClient:
    """
    Official API when credentials are configured (full pagination, higher
    rate limits); otherwise the zero-setup embed-page reader. Both expose
    the same ``get_playlist`` contract and ``Spotify*`` errors.
    """
    if spotify_configured():
        return SpotifyClient()
    return ScrapedSpotifyClient()


def _track_to_dict(track: SpotifyTrack) -> dict:
    return {
        "id": track.id,
        "title": track.title,
        "artists": track.artists,
        "artist": track.artist_display,
        "album": track.album,
        "artwork": track.album_artwork,
        "duration_ms": track.duration_ms,
        "spotify_url": track.spotify_url,
        "explicit": track.explicit,
    }


def _playlist_to_dict(playlist: SpotifyPlaylist) -> dict:
    return {
        "id": playlist.id,
        "name": playlist.name,
        "description": playlist.description,
        "owner": playlist.owner,
        "artwork": playlist.artwork,
        "spotify_url": playlist.spotify_url,
        "track_count": playlist.track_count,
        "tracks": [_track_to_dict(track) for track in playlist.tracks],
    }


def _match_to_dict(match: matching.TrackMatch) -> dict:
    return {
        "spotify": _track_to_dict(match.track),
        "status": match.status,
        "confidence": match.confidence,
        # Sanitized exactly like /search results: no tracking tokens, no
        # stream URLs, JPEG thumbnails only.
        "match": sanitize(match.match) if match.match else None,
        "error": match.error,
    }


async def _resolve_playlist(url: str) -> SpotifyPlaylist:
    try:
        playlist_id = parse_spotify_playlist_url(url)
    except SpotifyUrlError as exc:
        raise _spotify_error(exc) from exc
    loop = asyncio.get_running_loop()
    client = _spotify_client()
    try:
        try:
            return await loop.run_in_executor(executor, client.get_playlist, playlist_id)
        except SpotifyError as exc:
            raise _spotify_error(exc) from exc
    finally:
        client.close()


@router.get(
    "/spotify/playlist",
    summary="Resolve Spotify playlist",
    response_description="Playlist metadata and its full Spotify track list",
)
@sanitized
@cached("spotify_playlist", ttl=3600, id_arg="url")
async def resolve_spotify_playlist(
    url: str = Query(..., description="Spotify playlist link, URI or id"),
):
    """
    Turn a Spotify playlist link into metadata + tracks.

    This is the fast preview step of the import flow — no YouTube Music
    searching happens here.

    - **url**: any Spotify playlist link, ``spotify:playlist:`` URI or id
    """
    playlist = await _resolve_playlist(url)
    return _playlist_to_dict(playlist)


def _sse(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, default=str)}\n\n"


@router.post(
    "/spotify/to-ytmusic",
    summary="Convert Spotify playlist to YouTube Music",
    response_description="Server-sent event stream of per-track match results",
)
async def convert_spotify_to_ytmusic(body: ConvertRequest):
    """
    Convert a Spotify playlist track-by-track to YouTube Music matches.

    Streams ``text/event-stream``: a ``start`` event, one ``progress`` event
    per track (in playlist order), then ``done`` with the summary counts.
    The client renders these directly — no polling, no fake progress.
    """
    playlist = await _resolve_playlist(body.url)
    tracks = playlist.tracks[: body.limit]
    total = len(tracks)

    async def event_stream():
        yield _sse(
            "start",
            {
                "total": total,
                "playlist": {
                    "id": playlist.id,
                    "name": playlist.name,
                    "owner": playlist.owner,
                    "artwork": playlist.artwork,
                },
            },
        )

        semaphore = asyncio.Semaphore(_SEARCH_CONCURRENCY)
        loop = asyncio.get_running_loop()
        search_songs = partial(search, filter="songs", limit=15, ignore_spelling=True)

        async def convert_one(track: SpotifyTrack) -> matching.TrackMatch:
            async with semaphore:
                try:
                    # Blocking ytmusicapi call — runs on the shared executor
                    # like every other route (see server/state.py).
                    return await loop.run_in_executor(
                        executor, partial(matching.match_track, track, search_songs)
                    )
                except Exception as exc:  # noqa: BLE001
                    return matching.TrackMatch(
                        track=track, status="error", confidence=0.0, error=str(exc)
                    )

        tasks = [asyncio.create_task(convert_one(track)) for track in tracks]
        counts = {"matched": 0, "approximate": 0, "not_found": 0, "error": 0}
        try:
            for done, task in enumerate(tasks, start=1):
                result = await task
                counts[result.status] = counts.get(result.status, 0) + 1
                yield _sse(
                    "progress",
                    {"done": done, "total": total, "result": _match_to_dict(result)},
                )
        finally:
            # A disconnected client must not leave searches running.
            for task in tasks:
                if not task.done():
                    task.cancel()

        yield _sse(
            "done",
            {"summary": {"total": total, **counts}},
        )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
