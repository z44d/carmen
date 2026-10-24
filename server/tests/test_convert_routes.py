"""Route tests for server/routes/convert.py — resolve + SSE conversion."""

import json
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.routes.convert import router as convert_router
from server.spotify import SpotifyClient, SpotifyPlaylist, SpotifyTrack

PLAYLIST_URL = "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"


def make_playlist() -> SpotifyPlaylist:
    return SpotifyPlaylist(
        id="37i9dQZF1DXcBWIGoYBM5M",
        name="Test Mix",
        description="desc",
        owner="tester",
        artwork="https://i.scdn.co/cover",
        spotify_url=PLAYLIST_URL,
        tracks=[
            SpotifyTrack(id="t1", title="Blinding Lights", artists=["The Weeknd"],
                         duration_ms=202_000, spotify_url="https://open.spotify.com/track/t1"),
            SpotifyTrack(id="t2", title="Levitating", artists=["Dua Lipa"],
                         duration_ms=203_000, spotify_url="https://open.spotify.com/track/t2"),
            SpotifyTrack(id="t3", title="Obscure B-Side Nobody Covered", artists=["Unknown Act"],
                         duration_ms=180_000, spotify_url="https://open.spotify.com/track/t3"),
        ],
    )


class FakeSpotifyClient:
    def __init__(self, *args, **kwargs):
        pass

    def get_playlist(self, playlist_id):
        assert playlist_id == "37i9dQZF1DXcBWIGoYBM5M"
        return make_playlist()

    def close(self):
        pass


def fake_search(query, **kwargs):
    """Pretend YouTube Music search: exact hits for two tracks, junk for the third."""
    if "Blinding" in query:
        return [{
            "videoId": "yt1", "title": "Blinding Lights",
            "artists": [{"name": "The Weeknd"}], "duration": "3:22",
            "thumbnails": [{"url": "https://i.ytimg.com/vi/yt1/hqdefault.jpg"}],
            "feedbackTokens": {"should": "be stripped"},
        }]
    if "Levitating" in query:
        return [{
            "videoId": "yt2", "title": "Levitating",
            "artists": [{"name": "Dua Lipa"}], "duration": "3:23",
            "thumbnails": [{"url": "https://i.ytimg.com/vi/yt2/hqdefault.jpg"}],
        }]
    return [{"videoId": "junk", "title": "Something Entirely Different",
             "artists": [{"name": "Someone Else"}], "duration": "4:00"}]


@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(convert_router)
    with (
        patch("server.routes.convert.SpotifyClient", FakeSpotifyClient),
        patch("server.routes.convert.spotify_configured", return_value=True),
        patch("server.routes.convert.search", side_effect=fake_search),
    ):
        yield TestClient(app)


def parse_sse(text: str):
    """Parse a text/event-stream body into (event, payload) pairs."""
    events = []
    for chunk in text.strip().split("\n\n"):
        event = data = None
        for line in chunk.splitlines():
            if line.startswith("event:"):
                event = line[len("event:"):].strip()
            elif line.startswith("data:"):
                data = json.loads(line[len("data:"):].strip())
        events.append((event, data))
    return events


# ── GET /convert/spotify/playlist ─────────────────────────────────────────


def test_resolve_playlist_ok(client):
    response = client.get("/convert/spotify/playlist", params={"url": PLAYLIST_URL})
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["name"] == "Test Mix"
    assert payload["owner"] == "tester"
    assert payload["track_count"] == 3
    assert payload["tracks"][0]["title"] == "Blinding Lights"
    assert payload["tracks"][0]["artist"] == "The Weeknd"
    assert payload["tracks"][1]["artists"] == ["Dua Lipa"]


def test_resolve_playlist_bad_url_is_400(client):
    response = client.get("/convert/spotify/playlist", params={"url": "not a link"})
    assert response.status_code == 400
    assert "Spotify playlist link" in response.json()["detail"]


def test_resolve_playlist_unconfigured_uses_scraper():
    """No credentials -> zero-setup embed-page reader, not a 503."""
    app = FastAPI()
    app.include_router(convert_router)
    with (
        patch("server.routes.convert.ScrapedSpotifyClient", FakeSpotifyClient),
        patch("server.routes.convert.spotify_configured", return_value=False),
    ):
        client = TestClient(app)
        response = client.get("/convert/spotify/playlist", params={"url": PLAYLIST_URL})
    assert response.status_code == 200, response.text
    assert response.json()["name"] == "Test Mix"


def test_spotify_client_factory_prefers_api_when_configured(monkeypatch):
    # This sandbox ships malformed proxy env vars that break httpx.Client()
    # construction; they don't exist on real servers. Strip them so the
    # factory's real client construction can be exercised.
    for var in ("https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY",
                "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY"):
        monkeypatch.delenv(var, raising=False)

    from server.routes.convert import _spotify_client
    from server.spotify_scrape import ScrapedSpotifyClient

    with patch("server.routes.convert.spotify_configured", return_value=True):
        client = _spotify_client()
        assert isinstance(client, SpotifyClient)
        client.close()
    with patch("server.routes.convert.spotify_configured", return_value=False):
        client = _spotify_client()
        assert isinstance(client, ScrapedSpotifyClient)
        client.close()


# ── POST /convert/spotify/to-ytmusic (SSE) ────────────────────────────────


def test_convert_streams_progress_then_done(client):
    response = client.post("/convert/spotify/to-ytmusic", json={"url": PLAYLIST_URL})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")

    events = parse_sse(response.text)
    kinds = [event for event, _ in events]
    assert kinds[0] == "start"
    assert kinds[-1] == "done"
    assert kinds.count("progress") == 3

    start = events[0][1]
    assert start["total"] == 3
    assert start["playlist"]["name"] == "Test Mix"

    progress = [payload for event, payload in events if event == "progress"]
    assert [p["done"] for p in progress] == [1, 2, 3]
    statuses = [p["result"]["status"] for p in progress]
    assert statuses == ["matched", "matched", "not_found"]

    first = progress[0]["result"]
    assert first["spotify"]["title"] == "Blinding Lights"
    assert first["confidence"] >= 0.78
    assert first["match"]["videoId"] == "yt1"
    # Sanitized like every other API payload: tracking tokens are gone.
    assert "feedbackTokens" not in first["match"]
    assert first["match"]["thumbnails"][0]["url"].startswith("https://i.ytimg.com/")

    done = events[-1][1]["summary"]
    assert done == {"total": 3, "matched": 2, "approximate": 0, "not_found": 1, "error": 0}


def test_convert_respects_limit(client):
    response = client.post(
        "/convert/spotify/to-ytmusic", json={"url": PLAYLIST_URL, "limit": 1}
    )
    events = parse_sse(response.text)
    assert [e for e, _ in events].count("progress") == 1
    assert events[-1][1]["summary"]["total"] == 1


def test_convert_rejects_bad_limit(client):
    response = client.post(
        "/convert/spotify/to-ytmusic", json={"url": PLAYLIST_URL, "limit": 0}
    )
    assert response.status_code == 422


def test_convert_search_error_marks_track_error(client):
    def exploding_search(query, **kwargs):
        raise RuntimeError("ytm down")

    app = FastAPI()
    app.include_router(convert_router)
    with (
        patch("server.routes.convert.SpotifyClient", FakeSpotifyClient),
        patch("server.routes.convert.spotify_configured", return_value=True),
        patch("server.routes.convert.search", side_effect=exploding_search),
    ):
        test_client = TestClient(app)
        response = test_client.post("/convert/spotify/to-ytmusic", json={"url": PLAYLIST_URL})

    events = parse_sse(response.text)
    # match_track catches per-query errors itself, so these come back as
    # not_found rather than error — the batch survives either way.
    statuses = [p["result"]["status"] for e, p in events if e == "progress"]
    assert statuses == ["not_found", "not_found", "not_found"]
    assert events[-1][1]["summary"]["not_found"] == 3
