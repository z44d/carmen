import json
import logging
import os
import re
from pathlib import Path
from typing import NamedTuple
from urllib.parse import parse_qs, quote, unquote, urlparse
from urllib.request import Request, urlopen

from ytmusicapi import YTMusic
from ytmusicapi.parsers.browsing import parse_album

from .filters import (
    MAX_DURATION_SECONDS,
    DurationLimitExceeded,
    duration_of,
    parse_duration_seconds,
)

log = logging.getLogger(__name__)

ytm: YTMusic = None


def init_ytm(browser: str | Path):
    global ytm
    ytm = YTMusic(str(browser))

    return ytm


# ── Browsing ────────────────────────────────────────────────────────────────


def get_home(limit: int = 3):
    """
    Get the home page. Returns titled rows of music suggestions (artists, albums, songs, playlists).

    :param limit: number of rows to return per section

    https://ytmusicapi.readthedocs.io/en/stable/reference/browsing.html#ytmusicapi.YTMusic.get_home
    """
    return ytm.get_home(limit=limit)


def get_tasteprofile():
    """
    Fetches suggested artists from taste profile.
    Must be authenticated.

    https://ytmusicapi.readthedocs.io/en/stable/reference/browsing.html#ytmusicapi.YTMusic.get_tasteprofile
    """
    return ytm.get_tasteprofile()


def get_mood_categories():
    """
    Fetch "Moods & Genres" categories from YouTube Music.

    https://ytmusicapi.readthedocs.io/en/stable/reference/browsing.html#ytmusicapi.YTMusic.get_mood_categories
    """
    return ytm.get_mood_categories()


def get_mood_playlists(params: str):
    """
    Retrieve playlists for a given "Moods & Genres" category.

    :param params: params obtained from get_mood_categories()

    https://ytmusicapi.readthedocs.io/en/stable/reference/browsing.html#ytmusicapi.YTMusic.get_mood_playlists
    """
    return ytm.get_mood_playlists(params)


def get_explore():
    """
    Get latest explore data: new releases, top songs, moods & genres, trending, new videos.

    https://ytmusicapi.readthedocs.io/en/stable/reference/browsing.html#ytmusicapi.YTMusic.get_explore
    """
    return ytm.get_explore()


def get_charts(country: str = "ZZ"):
    """
    Get latest charts data: top video playlists, chart artists.

    :param country: ISO 3166-1 Alpha-2 country code. Defaults to "ZZ" (global).

    https://ytmusicapi.readthedocs.io/en/stable/reference/browsing.html#ytmusicapi.YTMusic.get_charts
    """
    return ytm.get_charts(country)


def get_artist(channelId: str):
    """
    Get info about an artist and their top releases (songs, albums, singles, videos, related).

    :param channelId: channel id of the artist

    https://ytmusicapi.readthedocs.io/en/stable/reference/browsing.html#ytmusicapi.YTMusic.get_artist
    """
    return ytm.get_artist(channelId)


def artist_shelf_params(channelId: str, shelf: str) -> str | None:
    """
    Extract the "view more" params token for one artist shelf ("Albums",
    "Singles", ...) directly from the raw browse response.

    get_artist() currently raises KeyError on the new visual-header artist
    layout (no ytmusicapi release parses it yet), so this reads the shelf
    headers itself and works across both layouts.
    """
    response = ytm._send_request("browse", {"browseId": channelId})
    tokens: list[str] = []

    def walk(node):
        if isinstance(node, dict):
            contents = (
                node.get("musicCarouselShelfRenderer")
                or node.get("musicShelfRenderer")
            )
            if isinstance(contents, dict) and _shelf_title(contents) == shelf:
                token = _more_content_params(contents)
                if token:
                    tokens.append(token)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    def _shelf_title(contents) -> str | None:
        header = contents.get("header")
        if not isinstance(header, dict):
            return None
        for value in header.values():
            if not isinstance(value, dict):
                continue
            title = value.get("title")
            if isinstance(title, dict):
                runs = title.get("runs")
                if runs and isinstance(runs, list):
                    return runs[0].get("text")
                return title.get("simpleText")
        return None

    def _more_content_params(contents) -> str | None:
        header = contents.get("header")
        if not isinstance(header, dict):
            return None
        for value in header.values():
            if not isinstance(value, dict):
                continue
            button = value.get("moreContentButton")
            if not isinstance(button, dict):
                continue
            token = (
                button.get("buttonRenderer", {})
                .get("navigationEndpoint", {})
                .get("browseEndpoint", {})
                .get("params")
            )
            if token:
                return token
        return None

    walk(response)
    return tokens[0] if tokens else None


def get_artist_albums(
    channelId: str, params: str, limit: int | None = 100, order: str | None = None
):
    """
    Get the full list of an artist's albums, singles, or shows.

    :param channelId: channel id of the artist
    :param params: params obtained from get_artist() or artist_shelf_params()
    :param limit: number of albums to return
    :param order: order of albums to return. Possible values: "Recency", "Popularity",
        "Alphabetical order" (ignored under the new snapshot page layout)

    https://ytmusicapi.readthedocs.io/en/stable/reference/browsing.html#ytmusicapi.YTMusic.get_artist_albums
    """
    try:
        return ytm.get_artist_albums(channelId, params, limit, order)
    except (KeyError, TypeError):
        # New-layout tokens yield a "full list" snapshot page (grid of two-row
        # items) that ytmusicapi's grid parser cannot read, or YT silently
        # ignores the params and serves the artist page instead.
        albums = _parse_album_snapshot(channelId, params)
        if not albums:
            decoded = unquote(params)
            if decoded != params:
                albums = _parse_album_snapshot(channelId, decoded)
        if not albums:
            return []
        return albums if limit is None else albums[:limit]


def _parse_album_snapshot(channelId: str, params: str) -> list:
    """Parse album cards out of a snapshot-style browse response (tolerant)."""
    response = ytm._send_request("browse", {"browseId": channelId, "params": params})
    albums: list = []
    seen: set[str] = set()

    def walk(node):
        if isinstance(node, dict):
            item = node.get("musicTwoRowItemRenderer")
            if isinstance(item, dict):
                browse_id = (
                    item.get("navigationEndpoint", {})
                    .get("browseEndpoint", {})
                    .get("browseId")
                )
                if (
                    isinstance(browse_id, str)
                    and browse_id.startswith("MPREb_")
                    and browse_id not in seen
                ):
                    try:
                        albums.append(parse_album(item))
                        seen.add(browse_id)
                    except Exception:  # card we can't read — skip it
                        pass
                return  # two-row items own their subtrees
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(response)
    return albums


def get_user(channelId: str):
    """
    Retrieve a user's page (videos or playlists).

    :param channelId: channel id of the user

    https://ytmusicapi.readthedocs.io/en/stable/reference/browsing.html#ytmusicapi.YTMusic.get_user
    """
    return ytm.get_user(channelId)


def get_user_playlists(channelId: str, params: str):
    """
    Retrieve a list of playlists for a given user.

    :param channelId: channel id of the user
    :param params: params obtained from get_user()

    https://ytmusicapi.readthedocs.io/en/stable/reference/browsing.html#ytmusicapi.YTMusic.get_user_playlists
    """
    return ytm.get_user_playlists(channelId, params)


def get_user_videos(channelId: str, params: str):
    """
    Retrieve a list of videos for a given user.

    :param channelId: channel id of the user
    :param params: params obtained from get_user()

    https://ytmusicapi.readthedocs.io/en/stable/reference/browsing.html#ytmusicapi.YTMusic.get_user_videos
    """
    return ytm.get_user_videos(channelId, params)


def get_album_browse_id(audioPlaylistId: str):
    """
    Get an album's browseId based on its audioPlaylistId (starting with OLAK5uy_).

    :param audioPlaylistId: audio playlist id of the album

    https://ytmusicapi.readthedocs.io/en/stable/reference/browsing.html#ytmusicapi.YTMusic.get_album_browse_id
    """
    return ytm.get_album_browse_id(audioPlaylistId)


def get_album(browseId: str):
    """
    Get information and tracks of an album. browseId must start with "MPRE".

    Tracklists are remapped onto the album's ``audioPlaylistId`` when the
    browse response serves official music videos (OMV) instead of the studio
    audio (ATV) — so opening an album anywhere yields the songs, exactly like
    YouTube Music's own app.

    :param browseId: browse id of the album

    https://ytmusicapi.readthedocs.io/en/stable/reference/browsing.html#ytmusicapi.YTMusic.get_album
    """
    return _prefer_audio_tracklist(ytm.get_album(browseId))


def _prefer_audio_tracklist(album: dict):
    """
    Album pages sometimes list ``MUSIC_VIDEO_TYPE_OMV`` entries — the official
    music videos — while the album's ``audioPlaylistId`` playlist carries the
    ATVs (studio audio) the app must play. Here the album's tracklist is
    rewritten in place from that audio playlist, position by position.
    """
    tracks = album.get("tracks") or []
    if not tracks:
        return album
    audio_only = all(t.get("videoType") == "MUSIC_VIDEO_TYPE_ATV" for t in tracks)
    if audio_only:
        return album

    audio_playlist_id = album.get("audioPlaylistId")
    if not audio_playlist_id:
        return album
    try:
        playlist = ytm.get_playlist(
            audio_playlist_id, limit=len(tracks), related=False, suggestions_limit=0
        )
    except Exception:  # playlist gone/private — serve the page as-is
        return album
    audio_tracks = playlist.get("tracks") or []
    if not audio_tracks:
        return album

    if len(audio_tracks) != len(tracks):
        # Positions can drift (bonus tracks, region extras) — fall back to a
        # title match, keeping positional mapping as the baseline.
        audio_by_title = {t.get("title"): t for t in audio_tracks}
        for pos, album_track in enumerate(tracks):
            audio_track = (
                audio_tracks[pos]
                if pos < len(audio_tracks)
                and album_track.get("title") == audio_tracks[pos].get("title")
                else audio_by_title.get(album_track.get("title"))
            )
            _remap_track(album_track, audio_track)
    else:
        for album_track, audio_track in zip(tracks, audio_tracks):
            _remap_track(album_track, audio_track)
    return album


def _remap_track(album_track: dict, audio_track: dict | None):
    """Point one album page row at its studio-audio counterpart if available."""
    if not audio_track or not audio_track.get("videoId"):
        return
    if album_track.get("videoId") == audio_track.get("videoId"):
        album_track["videoType"] = "MUSIC_VIDEO_TYPE_ATV"
        return
    album_track["videoId"] = audio_track["videoId"]
    if audio_track.get("creditsBrowseId"):
        album_track["creditsBrowseId"] = audio_track["creditsBrowseId"]
    if audio_track.get("duration_seconds"):
        album_track["duration_seconds"] = audio_track["duration_seconds"]
        if audio_track.get("duration"):
            album_track["duration"] = audio_track["duration"]
    if audio_track.get("album"):
        album_track["album"] = audio_track["album"]
    album_track["videoType"] = "MUSIC_VIDEO_TYPE_ATV"


def get_song(videoId: str, signatureTimestamp: int | None = None):
    """
    Returns metadata and streaming information about a song or video.

    :param videoId: video id of the song
    :param signatureTimestamp: timestamp of the base.js player. Obtained from get_signatureTimestamp().

    https://ytmusicapi.readthedocs.io/en/stable/reference/browsing.html#ytmusicapi.YTMusic.get_song
    """
    return ytm.get_song(
        videoId,
        signatureTimestamp if signatureTimestamp else ytm.get_signatureTimestamp(),
    )


def get_song_credits(browseId: str):
    """
    Get credits for a song (performed_by, written_by, produced_by, etc.).

    :param browseId: browse id of the song (starts with "MPTC")

    https://ytmusicapi.readthedocs.io/en/stable/reference/browsing.html#ytmusicapi.YTMusic.get_song_credits
    """
    return ytm.get_song_credits(browseId)


def get_song_related(browseId: str):
    """
    Gets related content for a song (from the "Related" tab of the watch panel).

    :param browseId: browse id of the song

    https://ytmusicapi.readthedocs.io/en/stable/reference/browsing.html#ytmusicapi.YTMusic.get_song_related
    """
    return ytm.get_song_related(browseId)


def get_lyrics(browseId: str, timestamps: bool | None = False):
    """
    Returns lyrics of a song/video.

    :param browseId: browse id of the song
    :param timestamps: return timed lyrics if available

    https://ytmusicapi.readthedocs.io/en/stable/reference/browsing.html#ytmusicapi.YTMusic.get_lyrics
    """
    return ytm.get_lyrics(browseId, timestamps)


# ── Animated artwork ───────────────────────────────────────────────────────


def get_animated_artwork(album_id: int) -> str | None:
    """
    Direct MP4 URL of an album's Apple Music "motion artwork" (animated cover).

    Uses CoverPy — the same client ``test.py`` exercises — which bootstraps an
    Apple web token, reads the album's ``editorialVideo`` metadata off the
    amp-api and walks the HLS ladder down to one self-contained MP4. Returns
    the resolved ``video_url`` (falling back to the HQ variant), or ``None``
    when the album simply ships no motion artwork.

    Transient upstream problems (Apple rate limits, token/network failures)
    are **not** swallowed here: they raise so the caller can skip caching and
    simply answer ``null`` for this request.

    :param album_id: iTunes collection id of the album
    """
    from coverpy import CoverPy  # local import: keep startup cost off the hot path

    with CoverPy(country="US") as client:
        motion = client.get_motion_artwork(album_id)
    if motion is None:
        return None
    return motion.video_url or motion.hq_video_url


def get_itunes_id_by_term(term: str, entity: str = "album") -> int | None:
    """
    iTunes collection id of a plain "Album - Artist" (or "Title - Artist")
    term, via CoverPy's catalog search.

    Shared by the browse-id route (which resolves the term from
    ``ytm.get_album``) and the term route (used by clients that carry no
    browse id at all — flat search / queue records, where the server only
    knows the album *name*).

    :param term: the lookup term, "Title - Artist" style like ``test.py``
    :param entity: ``"album"`` (default) or ``"song"`` — a song search
        points at the collection the track belongs to
    :return: the iTunes collection id, or ``None`` when there is no match
    """
    from coverpy import CoverPy  # local import: keep startup cost off the hot path
    from coverpy.exceptions import NoResultsError

    with CoverPy(country="US") as client:
        try:
            result = client.get_cover(term, entity=entity)
        except NoResultsError:
            return None
    return result.collection_id


def get_itunes_id(album_id: str) -> int | None:
    """
    iTunes collection id of a YouTube Music album, via CoverPy's catalog search.

    The client resolves most albums itself through the public iTunes Search
    API, but some clients (notably Safari — iOS *and* macOS) block that call
    — they fall back here, which does the same "Album - Artist" lookup
    server-side against the catalog CoverPy already talks to.

    :param album_id: the album's YouTube Music browse id (starts with "MPRE")
    :return: the iTunes collection id, or ``None`` when there is no match
    """
    album = ytm.get_album(album_id)
    title = album.get("title") or ""
    if not title:
        return None
    artists = album.get("artists") or []
    artist = artists[0].get("name", "") if artists and isinstance(artists[0], dict) else ""
    term = f"{title} - {artist}" if artist else title
    return get_itunes_id_by_term(term)


# ── Track enrichment ───────────────────────────────────────────────────────

_GENRE_HINT = re.compile(r"\bgenres?\b\s*[:\-]\s*([^\n|;]{2,40})", re.IGNORECASE)


_CDN_ARTWORK = "https://i.ytimg.com"


def _cdn_thumbnails(video_id: str) -> list:
    """
    Largest artwork for *video_id* from the ``i.ytimg.com`` CDN.

    Every song list in the app renders ``https://i.ytimg.com/vi/<id>/
    maxresdefault.jpg``: unlike ``yt3.googleusercontent.com`` — which answers
    a burst of artwork requests with ``429`` — these URLs are plain YouTube
    thumbnails served from the same CDN as the video itself.  **JPEG only**:
    the ``vi_webp`` WebP variants are never used, some browsers fail to paint
    them.

    Declared as 1280×1280 so it is the biggest entry of the merged list and
    therefore the last one, which is where the client reads it from.
    """
    if not video_id:
        return []
    return [
        {
            "url": f"{_CDN_ARTWORK}/vi/{video_id}/maxresdefault.jpg",
            "width": 1280,
            "height": 1280,
        }
    ]


def _merge_thumbnails(*candidates) -> list:
    """
    Merge every thumbnail source into a single list sorted by resolution.

    YouTube hands out the same artwork at several sizes from several
    endpoints (watch queue, ``videoDetails``, microformat) and each of them
    is usable on its own.  Combining them and sorting ascending guarantees
    that the **last** entry is always the largest image available — the
    player, the ambient background and the MP3 cover art all read it from
    there (``pickArtwork`` on the client).
    """
    merged: dict[str, dict] = {}

    def _add(items) -> None:
        if not isinstance(items, list):
            return
        for item in items:
            if not isinstance(item, dict):
                continue
            url = item.get("url")
            if not isinstance(url, str) or not url.startswith(("http://", "https://")):
                continue
            entry = {"url": url}
            width = item.get("width")
            height = item.get("height")
            if isinstance(width, int) and width:
                entry["width"] = width
            if isinstance(height, int) and height:
                entry["height"] = height
            existing = merged.get(url)
            # keep the entry that carries the resolution metadata
            if existing is None or ("width" not in existing and "width" in entry):
                merged[url] = entry

    for candidate in candidates:
        if isinstance(candidate, list):
            _add(candidate)
        elif isinstance(candidate, dict):
            _add(candidate.get("thumbnails"))

    ordered = sorted(
        merged.values(),
        key=lambda thumb: (
            thumb.get("width") or thumb.get("height") or 0,
            thumb.get("height") or 0,
        ),
    )
    return ordered


def _format_duration(seconds: int | None) -> str | None:
    if not seconds:
        return None
    minutes, secs = divmod(int(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def _lookup_genre(title: str, artist: str) -> str | None:
    """
    Best effort genre lookup through the public iTunes Search API.

    YouTube Music itself does not expose a genre for a track, so the lookup is
    attempted server side (cached by the route) with a short timeout and is
    allowed to fail silently.
    """
    if not title:
        return None
    term = quote(f"{artist} {title}".strip())
    request = Request(
        f"https://itunes.apple.com/search?term={term}&entity=song&limit=1",
        headers={"User-Agent": "Carmen/1.0"},
    )
    with urlopen(request, timeout=2) as response:
        payload = json.loads(response.read().decode("utf-8") or "{}")
    results = payload.get("results") or []
    if results:
        return results[0].get("primaryGenreName") or None
    return None


# ── Synced lyrics ──────────────────────────────────────────────────────────

_INNERTUBE_BROWSE = "https://music.youtube.com/youtubei/v1/browse?prettyPrint=false"
_LRCLIB_API = "https://lrclib.net/api"
_MOBILE_CLIENT = {"clientName": "ANDROID_MUSIC", "clientVersion": "7.21.50"}
_TIMED_LYRICS_PATH = (
    "contents",
    "elementRenderer",
    "newElement",
    "type",
    "componentType",
    "model",
    "timedLyricsModel",
    "lyricsData",
)
_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def _read_json(request: Request, timeout: int):
    """Issue a request and decode its JSON body, returning None on any failure."""
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", "replace") or ""
    except Exception:  # noqa: BLE001
        return None
    try:
        payload = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return payload


def _browse_mobile(browse_id: str) -> dict | None:
    """
    Ask YouTube for a lyrics page with a bare mobile innertube request.

    Only the Android client returns line timestamps, but sending the web
    ``Authorization: SAPISIDHASH`` header together with a mobile context is
    rejected with HTTP 400 — which is why ``ytmusicapi`` can only produce
    unsynced lyrics.  The very same call without any credential succeeds, so
    it is issued here directly.

    :param browse_id: lyrics browse id (``MPLYt…``)
    """
    body = json.dumps(
        {"browseId": browse_id, "context": {"client": _MOBILE_CLIENT}}
    ).encode("utf-8")
    request = Request(
        _INNERTUBE_BROWSE,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Origin": "https://music.youtube.com",
            "Referer": "https://music.youtube.com/",
            "User-Agent": _BROWSER_UA,
        },
        method="POST",
    )
    payload = _read_json(request, timeout=8)
    return payload if isinstance(payload, dict) else None


def _dig(node, path):
    """Walk a nested dict following *path*, returning None when it breaks off."""
    for key in path:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node


def _find_timed_lines(node):
    """
    Locate the raw timed lyric lines anywhere inside a lyrics payload.

    The exact nesting of the response shifts between clients, so the known
    path is tried first and a depth first scan is used as a safety net.
    """
    if isinstance(node, dict):
        for key in ("timedLyricsData", "timedLyrics", "lyricsData"):
            value = node.get(key)
            if (
                isinstance(value, list)
                and value
                and isinstance(value[0], dict)
                and ("cueRange" in value[0] or "lyricLine" in value[0])
            ):
                return value
        for value in node.values():
            found = _find_timed_lines(value)
            if found:
                return found
    elif isinstance(node, list):
        for value in node:
            found = _find_timed_lines(value)
            if found:
                return found
    return None


def _parse_timed_lines(raw_lines: list) -> list:
    """
    Convert raw mobile lyric lines into ``{timeMs, endTimeMs, text}`` dicts.

    Gaps are filled so the client always knows how long a line stays active
    (the player highlights the line until the next one starts).
    """
    lines = []
    for entry in raw_lines:
        if not isinstance(entry, dict):
            continue
        cue = entry.get("cueRange") or {}
        start = cue.get("startTimeMilliseconds")
        try:
            start_ms = int(start)
        except (TypeError, ValueError):
            continue
        if start_ms < 0:
            continue
        end = cue.get("endTimeMilliseconds")
        try:
            end_ms = int(end)
        except (TypeError, ValueError):
            end_ms = 0
        lines.append(
            {
                "timeMs": start_ms,
                "endTimeMs": max(end_ms, start_ms),
                "text": str(entry.get("lyricLine") or "").strip(),
            }
        )

    lines.sort(key=lambda line: line["timeMs"])
    for index, line in enumerate(lines):
        if line["endTimeMs"] <= line["timeMs"]:
            following = lines[index + 1] if index + 1 < len(lines) else None
            line["endTimeMs"] = following["timeMs"] if following else line["timeMs"] + 4000
    return lines


_LRC_LINE = re.compile(r"^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]\s?(.*)$")


def _parse_lrc(text) -> list | None:
    """Parse LRC text (``[mm:ss.xx] line``) into the synced lyrics shape."""
    if not isinstance(text, str) or not text.strip():
        return None

    lines = []
    for raw in text.splitlines():
        match = _LRC_LINE.match(raw.strip())
        if not match:
            continue
        minutes, seconds, fraction, body = match.groups()
        fraction_ms = int((fraction or "0").ljust(3, "0")[:3])
        start_ms = int(minutes) * 60_000 + int(seconds) * 1000 + fraction_ms
        body = body.strip()
        if not body:
            continue
        lines.append(
            {"timeMs": start_ms, "endTimeMs": start_ms, "text": body}
        )

    if not lines:
        return None

    lines.sort(key=lambda line: line["timeMs"])
    for index, line in enumerate(lines):
        following = lines[index + 1] if index + 1 < len(lines) else None
        line["endTimeMs"] = following["timeMs"] if following else line["timeMs"] + 4000
    return lines


#: Known lyrics providers understood by the ``provider`` query parameter.
#: ``auto`` (or omitting the parameter) keeps the default resolution chain.
LYRICS_PROVIDERS: dict[str, str] = {
    "lrclib": "Lrclib",
    "musixmatch": "Musixmatch",
    "netease": "NetEase",
    "megalobiz": "Megalobiz",
    "genius": "Genius",
}


def _syncedlyrics_lrc(
    title: str,
    artist: str,
    album: str,
    duration: int | None,
    provider: str | None = None,
):
    """
    Return raw **LRC** text for the track using the ``syncedlyrics`` library.

    The library walks a list of public providers (LRCLIB, Musixmatch, NetEase,
    …) and only reports a hit once it holds a genuinely timestamped LRC
    document, which is exactly what the karaoke view needs.  The lookup is
    allowed to fail silently — lyrics stay optional and a slow provider must
    never break the track payload.

    :param title: track title
    :param artist: artist name
    :param album: album name (only used to refine a query)
    :param duration: track length in seconds (unused by the lib, kept for
                     callers that build their own queries)
    :param provider: restrict the lookup to a single provider (a
                     :data:`LYRICS_PROVIDERS` key) instead of the whole list
    """
    if not (title or artist):
        return None

    try:
        import syncedlyrics
    except Exception:  # noqa: BLE001
        return None

    # An empty list means "every provider" for syncedlyrics (`None` would
    # crash its name-lowering comprehension).
    providers = [LYRICS_PROVIDERS[provider]] if provider in LYRICS_PROVIDERS else []
    # Genius only carries plain text — accept an unsynced document there.
    synced_only = provider != "genius"

    queries = [
        query
        for query in (
            f"{artist} {title}".strip(),
            f"{title} {album}".strip(),
            title,
        )
        if query
    ]

    for query in dict.fromkeys(queries):
        try:
            lrc = syncedlyrics.search(query, synced_only=synced_only, providers=providers)
        except Exception:  # noqa: BLE001
            lrc = None
        if isinstance(lrc, str) and (synced_only or _parse_lrc(lrc)):
            return lrc
    return None


def _collect_lyrics(
    browse_id: str | None,
    title: str = "",
    artist: str = "",
    album: str = "",
    duration: int | None = None,
    provider: str | None = None,
) -> dict:
    """
    Fetch both the synced and the plain lyrics for a lyrics browse id.

    Three sources are tried, in order:

    1. the mobile innertube ``browse`` endpoint, which is the only one that
       returns line timestamps (``ytmusicapi``'s own timed call fails with
       HTTP 400 because it pairs the web ``Authorization`` header with a
       mobile client context — see :func:`_browse_mobile`);
    2. ``ytmusicapi``'s plain lyrics endpoint for the unsynced text;
    3. the ``syncedlyrics`` library, which returns an LRC document (timestamped
       per line) from public providers, so a track still gets karaoke style
       lyrics when YouTube does not expose timestamps.

    When ``provider`` names a specific source (a :data:`LYRICS_PROVIDERS`
    key), the YouTube steps are skipped entirely and **only** that provider is
    consulted — the client's "Lyrics Provider" setting maps onto this.

    :param browse_id: lyrics browse id (``MPLYt…``) taken from the watch panel
    :param title: track title, used by the fallback lookup
    :param artist: first artist name, used by the fallback lookup
    :param album: album name, used by the fallback lookup
    :param duration: track duration in seconds, used by the fallback lookup
    :param provider: force a single lyrics provider (``None`` = default chain)
    """
    lyrics = {"browseId": browse_id, "synced": None, "unsynced": None, "source": None}

    if provider in LYRICS_PROVIDERS:
        lrc = _syncedlyrics_lrc(title, artist, album, duration, provider=provider)
        if lrc:
            lines = _parse_lrc(lrc)
            if lines:
                lyrics["synced"] = lines
                lyrics["source"] = LYRICS_PROVIDERS[provider]
                lyrics["unsynced"] = "\n".join(line["text"] for line in lines)
            elif provider == "genius":
                lyrics["unsynced"] = lrc
                lyrics["source"] = LYRICS_PROVIDERS[provider]
        return lyrics

    if browse_id:
        payload = _browse_mobile(browse_id)
        if payload:
            data = _dig(payload, _TIMED_LYRICS_PATH)
            raw_lines = data.get("timedLyricsData") if isinstance(data, dict) else None
            if not isinstance(raw_lines, list) or not raw_lines:
                raw_lines = _find_timed_lines(payload)
            source = data.get("sourceMessage") if isinstance(data, dict) else None
            if isinstance(raw_lines, list) and raw_lines:
                lines = _parse_timed_lines(raw_lines)
                if lines:
                    lyrics["synced"] = lines
                    lyrics["source"] = source

        if not lyrics["unsynced"]:
            try:
                plain = ytm.get_lyrics(browse_id, timestamps=False)
            except Exception:  # noqa: BLE001
                plain = None
            if plain:
                lyrics["unsynced"] = plain.get("lyrics")
                lyrics["source"] = lyrics["source"] or plain.get("source")

    if title and not lyrics["synced"]:
        lrc = _syncedlyrics_lrc(title, artist, album, duration)
        if lrc:
            lines = _parse_lrc(lrc)
            if lines:
                lyrics["synced"] = lines
                lyrics["source"] = lyrics["source"] or "SyncedLyrics"

    if not lyrics["unsynced"] and lyrics["synced"]:
        lyrics["unsynced"] = "\n".join(line["text"] for line in lyrics["synced"])

    return lyrics


def get_track(video_id: str, provider: str | None = None) -> dict:
    """
    Build one fully enriched payload for a single track.

    Combines the watch queue (title, artists, album, year, artwork), the
    player response (microformat / description) and the lyrics endpoint
    (synced + unsynced) so the client gets everything it needs — display,
    playback and the offline library — from a single request.

    :param video_id: YouTube video ID
    :param provider: force a lyrics provider (see :data:`LYRICS_PROVIDERS`);
                     ``None`` keeps the default resolution chain
    :raises DurationLimitExceeded: if the track is longer than one hour
    """
    watch: dict = {}
    try:
        watch = ytm.get_watch_playlist(videoId=video_id, limit=5) or {}
    except Exception:  # noqa: BLE001
        watch = {}

    queue = watch.get("tracks") or []
    base = next((t for t in queue if t.get("videoId") == video_id), {}) or {}

    song: dict = {}
    try:
        song = ytm.get_song(video_id) or {}
    except Exception:  # noqa: BLE001
        song = {}

    micro = ((song.get("microformat") or {}).get("microformatRenderer")) or {}
    details = song.get("videoDetails") or {}
    description = details.get("shortDescription") or micro.get("description") or ""

    title = base.get("title") or details.get("title") or ""
    artists = base.get("artists") or []
    if not artists and details.get("author"):
        artists = [{"name": details["author"], "id": None}]

    album = base.get("album") or {}
    year = base.get("year") or (micro.get("publishDate") or "")[:4] or None

    seconds = duration_of(base) or parse_duration_seconds(
        details.get("lengthSeconds")
    )
    if seconds and seconds > MAX_DURATION_SECONDS:
        raise DurationLimitExceeded(video_id, seconds)

    artist_name = artists[0]["name"] if artists and artists[0].get("name") else ""

    # Every thumbnail source merged, sorted smallest first: the last entry is
    # the biggest one available (the i.ytimg CDN entry, see `_cdn_thumbnails`).
    cdn = _cdn_thumbnails(video_id)
    thumbnails = _merge_thumbnails(
        cdn,
        # videoDetails carries the largest image (1280x720) and the watch
        # queue the YouTube Music sized ones.
        details.get("thumbnail"),
        micro.get("thumbnail"),
        base.get("thumbnails"),
        base.get("thumbnail"),
    )
    artwork = (cdn[0]["url"] if cdn else None) or (
        thumbnails[-1]["url"] if thumbnails else None
    )

    genre = None
    match = _GENRE_HINT.search(description or "")
    if match:
        genre = match.group(1).strip()
    if not genre:
        try:
            genre = _lookup_genre(title, artist_name)
        except Exception:  # noqa: BLE001
            genre = None
    if not genre:
        genre = micro.get("category")

    return {
        "videoId": video_id,
        "title": title,
        "artists": artists,
        "album": album,
        "year": year,
        "genre": genre,
        "duration": base.get("length")
        or base.get("duration")
        or _format_duration(seconds),
        "duration_seconds": seconds,
        # Largest artwork of the list — always the i.ytimg CDN entry, which is
        # also what `artwork` points at for a direct <img src>.
        "thumbnails": thumbnails,
        "artwork": artwork,
        "description": description,
        "isExplicit": base.get("isExplicit", False),
        "lyrics": _collect_lyrics(
            watch.get("lyrics"),
            title=title,
            artist=artist_name,
            album=album.get("name") if isinstance(album, dict) else str(album or ""),
            duration=seconds,
            provider=provider,
        ),
        "playlistId": watch.get("playlistId"),
        "relatedBrowseId": watch.get("related"),
    }


def _flatten_related(data, into: list) -> list:
    """Collect every song shaped dict found in a nested related payload."""
    if isinstance(data, dict):
        if data.get("videoId") and data.get("title"):
            into.append(data)
        for value in data.values():
            _flatten_related(value, into)
    elif isinstance(data, list):
        for entry in data:
            _flatten_related(entry, into)
    return into


def get_related(video_id: str, limit: int = 25) -> dict:
    """
    Return the contextually related songs for a track.

    Uses, in order, the watch queue (the songs YouTube Music plays next to
    this one), the "Related" watch panel and — as a last resort — the radio
    generated around the track.

    :param video_id: YouTube video ID used as the seed
    :param limit: maximum number of related tracks to return
    """
    tracks: list = []
    seen: set = set()
    watch: dict = {}

    def _add(items):
        for item in items or []:
            if not isinstance(item, dict):
                continue
            item_id = item.get("videoId")
            if not item_id or item_id == video_id or item_id in seen:
                continue
            seen.add(item_id)
            tracks.append(item)

    try:
        watch = ytm.get_watch_playlist(videoId=video_id, limit=limit) or {}
    except Exception:  # noqa: BLE001
        watch = {}
    _add(watch.get("tracks"))

    if watch.get("related"):
        try:
            panel = ytm.get_song_related(watch["related"]) or []
        except Exception:  # noqa: BLE001
            panel = []
        _add(_flatten_related(panel, []))

    if len(tracks) < 5:
        try:
            radio = (
                ytm.get_watch_playlist(videoId=video_id, limit=limit, radio=True) or {}
            )
        except Exception:  # noqa: BLE001
            radio = {}
        _add(radio.get("tracks"))

    return {
        "seed": video_id,
        "tracks": tracks[:limit],
        "playlistId": watch.get("playlistId"),
        "lyrics": watch.get("lyrics"),
    }


def get_basejs_url():
    """
    Extract the URL for the base.js script from YouTube Music.

    https://ytmusicapi.readthedocs.io/en/stable/reference/browsing.html#ytmusicapi.YTMusic.get_basejs_url
    """
    return ytm.get_basejs_url()


def get_signatureTimestamp(url: str | None = None):
    """
    Fetch base.js and parse the signatureTimestamp for use with get_song.

    :param url: URL of the base.js script. If not provided, will be fetched automatically.

    https://ytmusicapi.readthedocs.io/en/stable/reference/browsing.html#ytmusicapi.YTMusic.get_signatureTimestamp
    """
    return ytm.get_signatureTimestamp(url)


# ── Search ──────────────────────────────────────────────────────────────────


def search(
    query: str,
    filter: str | None = None,
    scope: str | None = None,
    limit: int = 20,
    ignore_spelling: bool = False,
):
    """
    Search YouTube Music.

    :param query: search query
    :param filter: filter for search results. Possible values: "songs", "videos", "albums", "artists", "playlists", "community_playlists", "featured_playlists", "profiles", "podcasts", "episodes"
    :param scope: scope of search. Possible values: "uploads", "library"
    :param limit: number of results to return
    :param ignore_spelling: ignore spelling suggestions and return the actual results for the entered query

    https://ytmusicapi.readthedocs.io/en/stable/reference/search.html#ytmusicapi.YTMusic.search
    """
    return ytm.search(query, filter, scope, limit, ignore_spelling)


def get_search_suggestions(query: str, detailed_runs: bool = False):
    """
    Get search suggestions.

    :param query: search query
    :param detailed_runs: return detailed runs with feedback tokens

    https://ytmusicapi.readthedocs.io/en/stable/reference/search.html#ytmusicapi.YTMusic.get_search_suggestions
    """
    return ytm.get_search_suggestions(query, detailed_runs)


# ── Watch ───────────────────────────────────────────────────────────────────


def get_watch_playlist(
    videoId: str | None = None,
    playlistId: str | None = None,
    limit: int = 25,
    radio: bool = False,
    shuffle: bool = False,
):
    """
    Get a watch list of tracks.

    :param videoId: video id of the song to start the playlist with
    :param playlistId: playlist id to get tracks from
    :param limit: number of tracks to return
    :param radio: enable radio mode (auto-generated playlist based on a seed)
    :param shuffle: shuffle the playlist

    Returns dict with keys: "tracks", "playlistId", "lyrics", "related"

    https://ytmusicapi.readthedocs.io/en/stable/reference/watch.html#ytmusicapi.YTMusic.get_watch_playlist
    """
    return ytm.get_watch_playlist(videoId, playlistId, limit, radio, shuffle)


# ── Podcasts ────────────────────────────────────────────────────────────────


def get_channel(channelId: str):
    """
    Get info about a podcast channel (episodes, podcasts). Max 10 episodes returned.

    :param channelId: channel id of the podcast

    https://ytmusicapi.readthedocs.io/en/stable/reference/podcasts.html#ytmusicapi.YTMusic.get_channel
    """
    return ytm.get_channel(channelId)


def get_channel_episodes(channelId: str, params: str):
    """
    Get all channel episodes.

    :param channelId: channel id of the podcast
    :param params: params obtained from get_channel()

    https://ytmusicapi.readthedocs.io/en/stable/reference/podcasts.html#ytmusicapi.YTMusic.get_channel_episodes
    """
    return ytm.get_channel_episodes(channelId, params)


def get_podcast(playlistId: str, limit: int | None = 100):
    """
    Returns podcast metadata and episodes.

    :param playlistId: playlist id of the podcast
    :param limit: number of episodes to return

    https://ytmusicapi.readthedocs.io/en/stable/reference/podcasts.html#ytmusicapi.YTMusic.get_podcast
    """
    return ytm.get_podcast(playlistId, limit)


def get_episode(videoId: str):
    """
    Retrieve episode data for a single episode.

    :param videoId: video id or browse id (MPED..) of the episode

    https://ytmusicapi.readthedocs.io/en/stable/reference/podcasts.html#ytmusicapi.YTMusic.get_episode
    """
    return ytm.get_episode(videoId)


# ── Playlists ───────────────────────────────────────────────────────────────


def get_playlist(
    playlistId: str,
    limit: int | None = 100,
    related: bool = False,
    suggestions_limit: int = 0,
):
    """
    Returns a list of playlist items with metadata (title, author, tracks, etc.).

    :param playlistId: playlist id
    :param limit: number of items to return
    :param related: return related playlists
    :param suggestions_limit: number of suggestions to return

    https://ytmusicapi.readthedocs.io/en/stable/reference/playlists.html#ytmusicapi.YTMusic.get_playlist
    """
    return ytm.get_playlist(playlistId, limit, related, suggestions_limit)


# ── Streaming ──────────────────────────────────────────────────────────────

import threading
import time

from yt_dlp import YoutubeDL

AUDIO_CACHE_DIR = Path(__file__).parent / ".audio_cache"
# Disk budget for the cache, not a file count: a track is ~5-15 MB, so the
# old "newest 100 files" cap could still fill the disk with long mixes.  The
# janitor task in ``__main__.py`` enforces this while the server runs; each
# completed download also prunes immediately.
AUDIO_CACHE_MAX_BYTES = 5 * 1024**3  # 5 GiB
AUDIO_CACHE_PRUNE_INTERVAL = 300  # seconds between janitor passes
AUDIO_SUFFIXES = (".m4a", ".mp4", ".webm", ".ogg", ".opus")

streaming_options = {
    # No browser cookie jar: decrypting Chrome's cookie store costs 1-3 seconds
    # on *every* yt-dlp attempt (it shells out to the OS keychain), a headless
    # server has no browser anyway, and playback does not need those cookies.
    "quiet": True,
    "cookiesfrombrowser": ("chrome", "Default"),
    "no_warnings": True,
    "js_runtimes": {"deno": {}},
    "format": "bestaudio[ext=m4a]/bestaudio/best",
}

_download_locks: dict[str, threading.Lock] = {}
_download_guard = threading.Lock()

# video_id -> (direct CDN url, request headers, unix expiry, player client).
# Filled by resolve_stream_url().
_STREAM_URLS: dict[str, tuple[str, dict, float, str | None]] = {}


def _lock_for(video_id: str) -> threading.Lock:
    """Return the download lock of *video_id*, creating it if needed."""
    with _download_guard:
        lock = _download_locks.get(video_id)
        if lock is None:
            lock = _download_locks[video_id] = threading.Lock()
        return lock


def find_cached_audio(video_id: str) -> Path | None:
    """Return the already downloaded audio file for *video_id*, if any."""
    for suffix in AUDIO_SUFFIXES:
        candidate = AUDIO_CACHE_DIR / f"{video_id}{suffix}"
        try:
            if candidate.is_file() and candidate.stat().st_size:
                # Bump mtime so the size-based prune treats this as the most
                # recently *used* file, not the most recently downloaded.
                try:
                    os.utime(candidate, None)
                except OSError:
                    pass  # a touch failure must never cost the cache hit
                return candidate
        except OSError:
            # an id the filesystem refuses (too long, odd characters) or a
            # file deleted between the two calls is simply not cached —
            # never let a stat turn into a 500 for the client
            continue
    return None


def cached_audio_files(video_id: str) -> list[Path]:
    """Every finished copy of *video_id* sitting in the audio cache.

    A song normally has exactly one.  More than one means a second writer
    (the relay tee, the Telegram mirror, a concurrent download) finished
    while the first was still running — see :func:`download_audio`, which
    drops its own copy when it finds one already there.
    """
    copies: list[Path] = []
    for suffix in AUDIO_SUFFIXES:
        candidate = AUDIO_CACHE_DIR / f"{video_id}{suffix}"
        try:
            if candidate.is_file() and candidate.stat().st_size:
                copies.append(candidate)
        except OSError:
            continue
    return copies


def audio_cache_bytes() -> int:
    """Total bytes currently occupied by the audio cache."""
    total = 0
    try:
        for p in AUDIO_CACHE_DIR.glob("*"):
            try:
                if p.is_file():
                    total += p.stat().st_size
            except OSError:
                continue
    except OSError:
        pass
    return total


def _prune_audio_cache():
    """Keep the on-disk audio cache within :data:`AUDIO_CACHE_MAX_BYTES`.

    Evicts least-recently-used files first (mtime is bumped on every cache
    hit, see :func:`find_cached_audio`).  Called after each completed
    download and periodically by the janitor task in ``__main__.py``.
    """
    try:
        files = sorted(
            (p for p in AUDIO_CACHE_DIR.glob("*") if p.is_file()),
            key=lambda p: p.stat().st_mtime,  # oldest (= least used) first
        )
        sizes: list[tuple[Path, int]] = []
        for p in files:
            try:
                sizes.append((p, p.stat().st_size))
            except OSError:
                continue
        total = sum(size for _, size in sizes)
        for p, size in sizes:
            if total <= AUDIO_CACHE_MAX_BYTES:
                break
            try:
                p.unlink(missing_ok=True)
                total -= size
            except OSError:
                continue
    except OSError:
        pass


def _duration_filter(info_dict, incomplete=False):
    """
    ``match_filter`` passed to yt-dlp: anything longer than one hour is
    rejected *before* yt-dlp starts writing bytes to disk.

    Returning a string makes ``process_info`` skip the download while still
    handing the extracted metadata back to the caller, which then raises
    :class:`DurationLimitExceeded`.
    """
    if incomplete:
        return None
    seconds = parse_duration_seconds((info_dict or {}).get("duration"))
    if seconds and seconds > MAX_DURATION_SECONDS:
        return f"is longer than one hour ({seconds} seconds)"
    return None


def _watch_url(video_id: str) -> str:
    return f"https://music.youtube.com/watch?v={video_id}"


# Player clients tried in order to fetch the audio.
#
# YouTube keeps tightening the default (web) client: stream URLs handed to
# datacenter IPs are regularly rejected with a 403 by the CDN.  The clients
# below were picked because they all expose a real audio-only stream (itag
# 140/m4a) instead of storyboard tiles or muxed video, so a fallback always
# yields a plain audio file.
STREAM_CLIENTS: tuple[str | None, ...] = (
    None,  # yt-dlp's default selection
    "tv_embedded",
    "visionos",
    "chrome",
    "android_music",
    "ios_music",
    "tv_embedded_simply",
)


def _client_options(client: str | None, outtmpl: str) -> dict:
    """yt-dlp options for one download attempt (single extraction + download)."""
    options = {
        **streaming_options,
        "outtmpl": outtmpl,
        "match_filter": _duration_filter,
    }
    if client:
        options["extractor_args"] = {"youtube": {"player_client": [client]}}
    return options


def _cleanup_partials(video_id: str):
    """Remove the half written files left behind by a failed attempt."""
    for stale in AUDIO_CACHE_DIR.glob(f"{video_id}*.part*"):
        stale.unlink(missing_ok=True)
    for stale in AUDIO_CACHE_DIR.glob(f"{video_id}*.ytdl"):
        stale.unlink(missing_ok=True)


_preferred_client: str | None = None


def _client_order() -> list:
    """
    Player clients to try, most likely to work first.

    The last client that successfully served audio is remembered so the next
    song does not have to repeat the failing attempt.
    """
    with _download_guard:
        preferred = _preferred_client
    order = list(STREAM_CLIENTS)
    if preferred in order:
        order.remove(preferred)
        order.insert(0, preferred)
    return order


def _remember_client(client: str | None):
    """Remember the player client that worked, for the next downloads."""
    global _preferred_client
    with _download_guard:
        _preferred_client = client


# Failures no other player client can fix: the video itself is gone, private
# or blocked.  Retrying the remaining clients would only pile their extraction
# time (5-12s each) onto a request that can never succeed — measured at 63s
# for a single unavailable track.
_PERMANENT_FAILURES = (
    "video unavailable",
    "private video",
    "video has been removed",
    "video has been deleted",
    "this video is unavailable",
    "no longer available",
    "has been terminated",
    "uploader has closed",
    "is not available",
    "not provide this video",
)


def _is_permanent_failure(exc: Exception) -> bool:
    """True when retrying with another player client cannot succeed."""
    message = str(exc).lower()
    return any(pattern in message for pattern in _PERMANENT_FAILURES)


class StreamTarget(NamedTuple):
    """A direct CDN URL plus everything the server needs to fetch it."""

    url: str
    headers: dict
    client: str | None


def resolve_stream_url(video_id: str, skip: set | None = None) -> StreamTarget:
    """
    Return a direct CDN URL **and** its request headers for *video_id*.

    yt-dlp only runs when there is nothing cached: the URL is kept in memory
    together with the ``expire`` timestamp the CDN put on it (a few hours), so
    every replay of a track inside the same server process skips extraction
    entirely — that is the difference between a ~200ms and a multi second
    start.

    :param skip: player clients to leave out (a client whose URL the CDN
                 already answered with ``403``)
    :raises DurationLimitExceeded: if the track is longer than one hour
    """
    skip = skip or set()
    now = time.time()
    with _download_guard:
        entry = _STREAM_URLS.get(video_id)
    if entry and entry[2] > now and entry[3] not in skip:
        return StreamTarget(entry[0], dict(entry[1]), entry[3])

    last_error: Exception | None = None
    permanent = 0
    for client in _client_order():
        if client in skip:
            continue
        try:
            url, headers = get_stream_details(video_id, client)
        except DurationLimitExceeded:
            raise
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if _is_permanent_failure(exc):
                # Playability can be client specific, so one alternative is
                # tried before giving up — but only one: a track that is
                # really gone costs ~12s per attempt, not ~60s.
                permanent += 1
                if permanent >= 2:
                    break
            continue
        _remember_client(client)
        with _download_guard:
            _STREAM_URLS[video_id] = (
                url,
                headers,
                time.time() + get_stream_url_ttl(url),
                client,
            )
        return StreamTarget(url, dict(headers), client)

    raise last_error or ValueError(f"could not resolve a stream URL for {video_id}")


def forget_stream_url(video_id: str) -> None:
    """Drop the cached stream URL of *video_id* (after a CDN 403, for example)."""
    with _download_guard:
        _STREAM_URLS.pop(video_id, None)


def get_stream_details(video_id: str, client: str | None = None) -> tuple[str, dict]:
    """
    Resolve a direct CDN URL **and** the request headers yt-dlp used.

    The headers matter: the CDN signs its URLs against the client that asked
    for them, so replaying a URL with a different ``User-Agent`` is a common
    source of ``403`` responses.

    :param video_id: YouTube video ID
    :param client: optional player client to force (see :data:`STREAM_CLIENTS`)
    :return: ``(url, headers)``
    :raises DurationLimitExceeded: if the track is longer than one hour
    :raises ValueError: if yt-dlp did not return a URL
    """
    options = dict(streaming_options)
    if client:
        options["extractor_args"] = {"youtube": {"player_client": [client]}}

    with YoutubeDL(options) as ydl:
        info = ydl.extract_info(_watch_url(video_id), download=False)

    seconds = parse_duration_seconds(info.get("duration"))
    if seconds and seconds > MAX_DURATION_SECONDS:
        raise DurationLimitExceeded(video_id, seconds)

    stream_url = info.get("url")
    if not stream_url:
        raise ValueError(f"yt-dlp returned no URL for video {video_id}")

    return stream_url, dict(info.get("http_headers") or {})


def get_stream_url(video_id: str, client: str | None = None) -> str:
    """Convenience wrapper around :func:`get_stream_details` (URL only)."""
    return get_stream_details(video_id, client)[0]


def get_stream_url_ttl(stream_url: str) -> int:
    """
    Parse the `expire` query param from a googlevideo URL and return the
    number of seconds until it expires (with a 60-second safety margin).
    Falls back to 300s (5 min) if parsing fails.
    """
    try:
        parsed = urlparse(stream_url)
        query_params = parse_qs(parsed.query)
        expire_ts = query_params.get("expire", [None])[0]
        if expire_ts:
            ttl = int(expire_ts) - int(time.time()) - 60
            return max(ttl, 60)
    except Exception:  # noqa: BLE001, S110
        pass
    return 300


def download_audio(video_id: str) -> str:
    """
    Download the audio of *video_id* on the server with yt-dlp.

    Extraction and download run in a **single** yt-dlp pass over the watch URL
    so the very same request headers are used to resolve and to fetch the
    media.  When a player client is rejected by the CDN (the common 403 on
    datacenter IPs) the next client in :data:`STREAM_CLIENTS` is tried.

    The one hour duration limit is enforced by :func:`_duration_filter` before
    any byte is written, and the finished file lands in the on-disk audio
    cache, so callers always get a local file instead of a remote audio URL.

    Concurrent calls for the same video share a single download.

    :param video_id: YouTube video ID
    :return: path of the cached audio file
    :raises DurationLimitExceeded: if the track is longer than one hour
    """
    AUDIO_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    cached = find_cached_audio(video_id)
    if cached:
        return str(cached)

    lock = _lock_for(video_id)
    with lock:
        cached = find_cached_audio(video_id)
        if cached:
            return str(cached)

        outtmpl = str(AUDIO_CACHE_DIR / f"{video_id}.%(ext)s")
        produced: Path | None = None
        last_error: Exception | None = None
        permanent = 0

        for client in _client_order():
            label = client or "default"
            try:
                with YoutubeDL(_client_options(client, outtmpl)) as ydl:
                    info = ydl.extract_info(_watch_url(video_id), download=True) or {}

                seconds = parse_duration_seconds(info.get("duration"))
                if seconds and seconds > MAX_DURATION_SECONDS:
                    # match_filter skipped the download, drop any leftover
                    for leftover in AUDIO_CACHE_DIR.glob(f"{video_id}.*"):
                        leftover.unlink(missing_ok=True)
                    raise DurationLimitExceeded(video_id, seconds)

                candidate = Path(ydl.prepare_filename(info))
                if not candidate.is_file():
                    matches = sorted(
                        AUDIO_CACHE_DIR.glob(f"{video_id}.*"),
                        key=lambda p: p.stat().st_mtime,
                        reverse=True,
                    )
                    if not matches:
                        raise ValueError(
                            f"yt-dlp did not produce an audio file for {video_id}"
                        )
                    candidate = matches[0]

                if candidate.is_file() and candidate.stat().st_size:
                    produced = candidate
                    _remember_client(client)
                    break
            except DurationLimitExceeded:
                raise
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                _cleanup_partials(video_id)
                log.warning(
                    "Audio download for %s failed with the %s client: %s",
                    video_id,
                    label,
                    exc,
                )
                # A track that no longer exists cannot be rescued by the next
                # player client — stop instead of paying its extraction time
                # (~12s per attempt).  One alternative is tried first because
                # playability really can be client specific.
                if _is_permanent_failure(exc):
                    permanent += 1
                    if permanent >= 2:
                        break

        if produced is None:
            raise last_error or ValueError(
                f"yt-dlp did not produce an audio file for {video_id}"
            )

        # One file per video id: while yt-dlp ran, a relay tee or a Telegram
        # mirror may have stored the same track (that race is what used to
        # leave a `.m4a` and a byte-identical `.mp4` behind for one song).
        # The copy that landed first is the cache — drop ours and serve that.
        others = [p for p in cached_audio_files(video_id) if p != produced]
        if others:
            try:
                produced.unlink(missing_ok=True)
            except OSError:
                others = []  # could not drop ours — keep both rather than lose one
            if others:
                produced = others[0]
                log.debug(
                    "Kept the cache copy of %s that already existed: %s",
                    video_id,
                    produced.name,
                )

        _prune_audio_cache()

    with _download_guard:
        _download_locks.pop(video_id, None)

    return str(produced)
