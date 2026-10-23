"""Tests for server/spotify_scrape.py — the zero-setup embed-page reader."""

import json

import httpx
import pytest

from server.spotify import SpotifyApiError, SpotifyNotFoundError
from server.spotify_scrape import ScrapedSpotifyClient, parse_embed_html


def _embed_html(entity: dict) -> str:
    payload = {"props": {"pageProps": {"state": {"data": {"entity": entity}}}}}
    return (
        "<html><head>"
        f'<script id="__NEXT_DATA__" type="application/json">{json.dumps(payload)}</script>'
        "</head><body></body></html>"
    )


def _track(uri_suffix: str, title: str, artist: str, duration_ms: int = 200_000,
           explicit: bool = False) -> dict:
    return {
        "uri": f"spotify:track:{uri_suffix}",
        "title": title,
        "subtitle": artist,
        "duration": duration_ms,
        "isExplicit": explicit,
        "entityType": "track",
    }


def _entity(**overrides) -> dict:
    entity = {
        "title": "Test Mix",
        "subtitle": "tester",
        "uri": "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M",
        "coverArt": {"sources": [{"url": "https://i.scdn.co/image/abc"}]},
        "attributes": [{"key": "description", "value": "a test playlist"}],
        "trackList": [
            _track("t1", "Blinding Lights", "The Weeknd", 202_000),
            _track("t2", "Levitating", "Dua Lipa", 203_000, explicit=True),
        ],
    }
    entity.update(overrides)
    return entity


def test_parse_embed_html_maps_playlist_and_tracks():
    playlist = parse_embed_html(_embed_html(_entity()), "37i9dQZF1DXcBWIGoYBM5M")

    assert playlist.id == "37i9dQZF1DXcBWIGoYBM5M"
    assert playlist.name == "Test Mix"
    assert playlist.owner == "tester"
    assert playlist.artwork == "https://i.scdn.co/image/abc"
    assert playlist.description == "a test playlist"
    assert playlist.spotify_url == "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"

    assert playlist.track_count == 2
    first, second = playlist.tracks
    assert (first.id, first.title, first.artists) == ("t1", "Blinding Lights", ["The Weeknd"])
    assert first.duration_ms == 202_000
    assert first.spotify_url == "https://open.spotify.com/track/t1"
    assert first.explicit is False
    assert second.explicit is True
    assert second.artist_display == "Dua Lipa"


def test_parse_embed_html_skips_non_tracks_and_empty_uris():
    entity = _entity(trackList=[
        _track("t1", "Real Song", "Artist"),
        {"uri": "", "title": "No URI", "entityType": "track"},
        {"uri": "spotify:episode:e1", "title": "A Podcast", "entityType": "episode"},
    ])
    playlist = parse_embed_html(_embed_html(entity), "x")
    assert [t.id for t in playlist.tracks] == ["t1"]


def test_parse_embed_html_tolerates_missing_optional_fields():
    playlist = parse_embed_html(_embed_html(_entity(coverArt={}, attributes=[])), "x")
    assert playlist.artwork is None
    assert playlist.description == ""


def test_parse_embed_html_rejects_pages_without_payload():
    with pytest.raises(SpotifyApiError):
        parse_embed_html("<html><body>hello</body></html>", "x")


def test_parse_embed_html_rejects_unexpected_shape():
    with pytest.raises(SpotifyApiError):
        parse_embed_html(_embed_html({"title": "nope"}), "x")


def _client_with(handler) -> ScrapedSpotifyClient:
    return ScrapedSpotifyClient(http=httpx.Client(transport=httpx.MockTransport(handler)))


def test_client_get_playlist_ok():
    html = _embed_html(_entity())

    def handler(request: httpx.Request) -> httpx.Response:
        assert "embed/playlist/37i9dQZF1DXcBWIGoYBM5M" in str(request.url)
        assert "Mozilla" in request.headers["user-agent"]
        return httpx.Response(200, text=html)

    client = _client_with(handler)
    try:
        playlist = client.get_playlist("37i9dQZF1DXcBWIGoYBM5M")
    finally:
        client.close()
    assert playlist.name == "Test Mix"
    assert playlist.track_count == 2


def test_client_404_is_not_found():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="not found")

    client = _client_with(handler)
    try:
        with pytest.raises(SpotifyNotFoundError):
            client.get_playlist("nope")
    finally:
        client.close()


def test_client_500_is_api_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    client = _client_with(handler)
    try:
        with pytest.raises(SpotifyApiError):
            client.get_playlist("x")
    finally:
        client.close()


def test_client_network_failure_is_api_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("dns down")

    client = _client_with(handler)
    try:
        with pytest.raises(SpotifyApiError):
            client.get_playlist("x")
    finally:
        client.close()
