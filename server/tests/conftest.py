"""
Test bootstrap for the carmen server.

The converter modules only need stdlib + httpx + fastapi, but importing
``server.routes`` pulls in the whole router package (which touches
``server.core`` → ytmusicapi, ``server.state`` → redis, ``routes.stream`` →
yt-dlp). Those heavy, optional-at-test-time dependencies are stubbed here so
the suite runs in a light venv. Production imports are unaffected.
"""

import sys
from unittest.mock import MagicMock

import pytest


def _stub_module(name: str, **attrs) -> MagicMock:
    module = MagicMock(name=f"stub:{name}")
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules[name] = module
    return module


def _install_stubs() -> None:
    if "ytmusicapi" in sys.modules:
        return
    ytmusicapi = _stub_module("ytmusicapi", YTMusic=MagicMock)
    parsers = _stub_module("ytmusicapi.parsers")
    _stub_module("ytmusicapi.parsers.browsing", parse_album=MagicMock)
    ytmusicapi.parsers = parsers

    redis_pkg = _stub_module("redis")
    redis_asyncio = _stub_module("redis.asyncio")
    _stub_module("redis.asyncio.client", Redis=MagicMock)
    redis_pkg.asyncio = redis_asyncio

    yt_dlp = _stub_module("yt_dlp", YoutubeDL=MagicMock)
    _stub_module("yt_dlp.utils", DownloadError=type("DownloadError", (Exception,), {}))
    yt_dlp.utils = sys.modules["yt_dlp.utils"]


_install_stubs()


@pytest.fixture(autouse=True)
def _clean_spotify_env(monkeypatch):
    """Spotify credential env is opt-in per test — never leak between tests."""
    monkeypatch.delenv("SPOTIFY_CLIENT_ID", raising=False)
    monkeypatch.delenv("SPOTIFY_CLIENT_SECRET", raising=False)
