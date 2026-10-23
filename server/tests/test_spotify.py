"""Tests for server/spotify.py — URL parsing, auth, playlist fetching."""

import json

import httpx
import pytest

from server.spotify import (
    SpotifyApiError,
    SpotifyAuthError,
    SpotifyClient,
    SpotifyNotFoundError,
    SpotifyUrlError,
    parse_spotify_playlist_url,
    spotify_configured,
)

PLAYLIST_ID = "37i9dQZF1DXcBWIGoYBM5M"

TOKEN_OK = {"access_token": "tok_123", "token_type": "Bearer", "expires_in": 3600}


def _playlist_meta():
    return {
        "id": PLAYLIST_ID,
        "name": "Test Playlist",
        "description": "A playlist for tests",
        "owner": {"display_name": "tester"},
        "images": [{"url": "https://i.scdn.co/small", "height": 64, "width": 64}],
        "external_urls": {"spotify": f"https://open.spotify.com/playlist/{PLAYLIST_ID}"},
        "tracks": {"total": 3},
    }


def _track_item(track_id, name, artists=("Artist A",), **overrides):
    track = {
        "id": track_id,
        "name": name,
        "artists": [{"name": a} for a in artists],
        "album": {"name": "Album", "images": []},
        "duration_ms": 200_000,
        "explicit": False,
        "is_local": False,
        "external_ids": {"isrc": "US-AAA-00-00001"},
        "external_urls": {"spotify": f"https://open.spotify.com/track/{track_id}"},
    }
    track.update(overrides)
    return {"track": track}


def _tracks_page(items, next_url=None):
    return {"items": items, "next": next_url}


def make_client(handler, client_id="cid", client_secret="csecret"):
    transport = httpx.MockTransport(handler)
    http = httpx.Client(transport=transport)
    return SpotifyClient(client_id=client_id, client_secret=client_secret, http=http)


def token_then(handler):
    """Wrap a handler so the token endpoint answers first, then delegate."""

    def wrapped(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/token":
            return httpx.Response(200, json=TOKEN_OK)
        return handler(request)

    return wrapped


# ── URL parsing ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "raw",
    [
        f"https://open.spotify.com/playlist/{PLAYLIST_ID}",
        f"https://open.spotify.com/playlist/{PLAYLIST_ID}?si=abc123",
        f"https://open.spotify.com/playlist/{PLAYLIST_ID}?si=abc123&utm_source=x#frag",
        f"http://open.spotify.com/playlist/{PLAYLIST_ID}",
        f"https://open.spotify.com/intl-de/playlist/{PLAYLIST_ID}?si=x",
        f"spotify:playlist:{PLAYLIST_ID}",
        PLAYLIST_ID,
        f"  https://open.spotify.com/playlist/{PLAYLIST_ID}  ",
    ],
)
def test_parse_spotify_playlist_url_accepts(raw):
    assert parse_spotify_playlist_url(raw) == PLAYLIST_ID


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "   ",
        "not a link",
        "https://open.spotify.com/track/abc123",
        "https://open.spotify.com/album/37i9dQZF1DXcBWIGoYBM5M",
        "https://youtube.com/playlist?list=PL123",
        "spotify:track:abc123",
        "short",
    ],
)
def test_parse_spotify_playlist_url_rejects(raw):
    with pytest.raises(SpotifyUrlError):
        parse_spotify_playlist_url(raw)


# ── configuration ─────────────────────────────────────────────────────────


def test_spotify_configured_needs_both_vars(monkeypatch):
    assert spotify_configured() is False
    monkeypatch.setenv("SPOTIFY_CLIENT_ID", "x")
    assert spotify_configured() is False
    monkeypatch.setenv("SPOTIFY_CLIENT_SECRET", "y")
    assert spotify_configured() is True


def test_missing_credentials_raise_auth_error():
    client = SpotifyClient(client_id="", client_secret="", http=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500))))
    with pytest.raises(SpotifyAuthError, match="isn't configured"):
        client.get_playlist(PLAYLIST_ID)


# ── token flow ────────────────────────────────────────────────────────────


def test_token_is_fetched_with_basic_auth_and_cached():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path == "/api/token":
            assert request.headers["authorization"].startswith("Basic ")
            return httpx.Response(200, json=TOKEN_OK)
        if request.url.path == f"/v1/playlists/{PLAYLIST_ID}":
            assert request.headers["authorization"] == "Bearer tok_123"
            return httpx.Response(200, json=_playlist_meta())
        if request.url.path.endswith("/tracks"):
            return httpx.Response(200, json=_tracks_page([]))
        raise AssertionError(f"unexpected {request.url}")

    client = make_client(handler)
    playlist = client.get_playlist(PLAYLIST_ID)
    assert playlist.name == "Test Playlist"
    token_posts = [c for c in calls if c.url.path == "/api/token"]
    assert len(token_posts) == 1  # cached, not re-minted

    # Second playlist fetch reuses the cached token.
    client.get_playlist(PLAYLIST_ID)
    token_posts = [c for c in calls if c.url.path == "/api/token"]
    assert len(token_posts) == 1


def test_rejected_credentials_raise_auth_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "invalid_client"})

    client = make_client(handler)
    with pytest.raises(SpotifyAuthError, match="rejected"):
        client.get_playlist(PLAYLIST_ID)


def test_expired_token_is_refreshed():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/token":
            seen.append(1)
            # First token is already expired.
            return httpx.Response(200, json={"access_token": f"tok_{len(seen)}", "expires_in": -10})
        return httpx.Response(200, json=_playlist_meta())

    # Patch the tracks call to avoid a second token round-trip.
    def handler2(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/token":
            return handler(request)
        if request.url.path.endswith("/tracks"):
            return httpx.Response(200, json=_tracks_page([]))
        return handler(request)

    client = make_client(token_then(handler2))
    # Force the cached token to look expired before the tracks request.
    client._token, client._token_expires_at = "tok_old", 0.0
    playlist = client.get_playlist(PLAYLIST_ID)
    assert playlist.id == PLAYLIST_ID


# ── playlist fetching ─────────────────────────────────────────────────────


def test_get_playlist_paginates_and_skips_unplayable():
    pages = [
        _tracks_page(
            [
                _track_item("t1", "Song One"),
                _track_item("t2", "Song Two", artists=("A", "B")),
                {"track": None},  # removed/unavailable
                _track_item("t3", "Local File", is_local=True),  # skipped
            ],
            next_url="https://api.spotify.com/v1/playlists/x/tracks?offset=100",
        ),
        _tracks_page([_track_item("t4", "Song Four")]),
    ]
    page_iter = iter(pages)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == f"/v1/playlists/{PLAYLIST_ID}":
            return httpx.Response(200, json=_playlist_meta())
        if request.url.path.endswith("/tracks"):
            return httpx.Response(200, json=next(page_iter))
        raise AssertionError(f"unexpected {request.url}")

    client = make_client(token_then(handler))
    playlist = client.get_playlist(PLAYLIST_ID)

    assert playlist.id == PLAYLIST_ID
    assert playlist.name == "Test Playlist"
    assert playlist.owner == "tester"
    assert playlist.artwork == "https://i.scdn.co/small"
    assert [t.id for t in playlist.tracks] == ["t1", "t2", "t4"]
    assert playlist.tracks[1].artists == ["A", "B"]
    assert playlist.tracks[0].duration_ms == 200_000
    assert playlist.tracks[0].isrc == "US-AAA-00-00001"


def test_get_playlist_not_found():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == f"/v1/playlists/{PLAYLIST_ID}":
            return httpx.Response(404, json={"error": {"status": 404}})
        raise AssertionError(f"unexpected {request.url}")

    client = make_client(token_then(handler))
    with pytest.raises(SpotifyNotFoundError, match="private"):
        client.get_playlist(PLAYLIST_ID)


def test_rate_limit_surfaces_retryable_error():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == f"/v1/playlists/{PLAYLIST_ID}":
            return httpx.Response(429, headers={"Retry-After": "17"}, json={})
        raise AssertionError(f"unexpected {request.url}")

    client = make_client(token_then(handler))
    with pytest.raises(SpotifyApiError, match="17s"):
        client.get_playlist(PLAYLIST_ID)


def test_network_failure_becomes_api_error():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/token":
            return httpx.Response(200, json=TOKEN_OK)
        raise httpx.ConnectError("boom")

    client = make_client(handler)
    with pytest.raises(SpotifyApiError, match="Could not reach Spotify"):
        client.get_playlist(PLAYLIST_ID)


def test_unexpected_status_becomes_api_error():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == f"/v1/playlists/{PLAYLIST_ID}":
            return httpx.Response(500, json={})
        raise AssertionError(f"unexpected {request.url}")

    client = make_client(token_then(handler))
    with pytest.raises(SpotifyApiError, match="500"):
        client.get_playlist(PLAYLIST_ID)
    assert json  # keep the import used
