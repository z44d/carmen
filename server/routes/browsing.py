import asyncio
import hashlib
from contextlib import suppress
from functools import partial

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import state
from ..cache import cached
from ..core import (
    LYRICS_PROVIDERS,
    artist_shelf_params,
    get_album,
    get_album_browse_id,
    get_animated_artwork,
    get_artist,
    get_artist_albums,
    get_basejs_url,
    get_charts,
    get_explore,
    get_home,
    get_itunes_id,
    get_itunes_id_by_term,
    get_lyrics,
    get_mood_categories,
    get_mood_playlists,
    get_provider_lyrics,
    get_related,
    get_signatureTimestamp,
    get_song,
    get_song_credits,
    get_song_related,
    get_tasteprofile,
    get_track,
    get_user,
    get_user_playlists,
    get_user_videos,
    translate_lyrics,
)
from ..filters import (
    MAX_DURATION_SECONDS,
    DurationLimitExceeded,
    parse_duration_seconds,
)
from ..sanitizers import sanitized
from ..state import executor

router = APIRouter(prefix="/browsing", tags=["Browsing"])


def _guard_duration(result, video_id: str):
    """Reject tracks longer than one hour with an explicit 400."""
    details = (result or {}).get("videoDetails") or {}
    seconds = parse_duration_seconds(details.get("lengthSeconds"))
    if seconds and seconds > MAX_DURATION_SECONDS:
        raise HTTPException(
            status_code=400,
            detail=DurationLimitExceeded(video_id, seconds).args[0],
        )
    return result


def _chain_provider_ids() -> set:
    """Ids of the new lyrics chain; empty when the package is unavailable."""
    try:
        from ..lyrics import PROVIDER_IDS
    except Exception:  # noqa: BLE001
        return set()
    return set(PROVIDER_IDS)


def _parse_id_list(value: str | None) -> list[str] | None:
    """Comma-separated query value -> id list (``None`` when absent/blank)."""
    if value is None:
        return None
    ids = [part.strip() for part in value.split(",")]
    ids = [part for part in ids if part]
    return ids or None


def _validate_chain_ids(ids: list[str] | None, param: str) -> None:
    """400 on any id outside the chain registry (same style as ``track``)."""
    if not ids:
        return
    known = _chain_provider_ids()
    if not known:
        return  # registry unavailable — the core treats unknowns as default
    unknown = [part for part in ids if part not in known]
    if unknown:
        raise HTTPException(
            status_code=400,
            detail=f"unknown lyrics provider {unknown[0]!r} "
            f"(expected one of: {', '.join(sorted(known))})",
        )



@router.get(
    "/home",
    summary="Get Home Page",
    response_description="List of music suggestion rows",
)
@sanitized
@cached("home", ttl=3600)
async def home(limit: int = 3):
    """
    Get the home page with music suggestions.

    Returns titled rows of music suggestions including artists, albums, songs, and playlists.

    - **limit**: number of rows to return per section (default: 3)
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(executor, partial(get_home, limit))


@router.get(
    "/tasteprofile",
    summary="Get Taste Profile",
    response_description="Suggested artists from taste profile",
)
@sanitized
@cached("tasteprofile", ttl=3600)
async def tasteprofile():
    """
    Fetch suggested artists from taste profile.

    Must be authenticated. Returns artists recommended based on listening history.
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(executor, partial(get_tasteprofile))


@router.get(
    "/mood-categories",
    summary="Get Mood Categories",
    response_description="List of mood and genre categories",
)
@sanitized
@cached("mood_categories", ttl=1800)
async def mood_categories():
    """
    Fetch "Moods & Genres" categories from YouTube Music.

    Returns a list of categories like "Energetic", "Sad", "Workout", etc.
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(executor, partial(get_mood_categories))


@router.get(
    "/mood-playlists/{params}",
    summary="Get Mood Playlists",
    response_description="List of playlists for the given mood",
)
@sanitized
@cached("mood_playlists", ttl=3600)
async def mood_playlists(params: str):
    """
    Retrieve playlists for a given "Moods & Genres" category.

    - **params**: params obtained from get_mood_categories()
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(executor, partial(get_mood_playlists, params))


@router.get(
    "/explore",
    summary="Get Explore Data",
    response_description="Latest explore data including new releases and trending",
)
@sanitized
@cached("explore", ttl=3600)
async def explore():
    """
    Get latest explore data.

    Returns new releases, top songs, moods & genres, trending content, and new videos.
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(executor, partial(get_explore))


@router.get(
    "/charts",
    summary="Get Charts",
    response_description="Charts data for the specified country",
)
@sanitized
@cached("charts", ttl=3600)
async def charts(country: str = "ZZ"):
    """
    Get latest charts data.

    - **country**: ISO 3166-1 Alpha-2 country code (default: "ZZ" for global)
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(executor, partial(get_charts, country))


@router.get(
    "/artist/{channelId}",
    summary="Get Artist",
    response_description="Artist info with top releases",
)
@sanitized
@cached("artist", ttl=86400, id_arg="channelId")
async def artist(channelId: str):
    """
    Get info about an artist and their top releases.

    Returns songs, albums, singles, videos, and related artists.

    - **channelId**: YouTube channel ID of the artist
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(executor, partial(get_artist, channelId))


@router.get(
    "/artist/{channelId}/albums",
    summary="Get Artist Albums",
    response_description="List of artist albums",
)
@sanitized
@cached("artist_albums", ttl=86400, id_arg="channelId", extra_args=("params",))
async def artist_albums(
    channelId: str, params: str | None = None, limit: int = 100, order: str | None = None
):
    """
    Get the full list of an artist's albums, singles, or shows.

    - **channelId**: YouTube channel ID of the artist
    - **params**: params obtained from get_artist(); auto-derived from the
        artist page's Albums shelf when omitted (artists without one return [])
    - **limit**: number of albums to return (default: 100)
    - **order**: "Recency", "Popularity", or "Alphabetical order"
    """
    loop = asyncio.get_running_loop()
    if params is None:
        params = await loop.run_in_executor(
            executor, partial(artist_shelf_params, channelId, "Albums")
        )
        if params is None:
            return []  # artist has no albums shelf to page through
    return await loop.run_in_executor(
        executor, partial(get_artist_albums, channelId, params, limit, order)
    )


@router.get(
    "/user/{channelId}",
    summary="Get User",
    response_description="User page info",
)
@sanitized
@cached("user", ttl=86400, id_arg="channelId")
async def user(channelId: str):
    """
    Retrieve a user's page (videos or playlists).

    - **channelId**: YouTube channel ID of the user
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(executor, partial(get_user, channelId))


@router.get(
    "/user/{channelId}/playlists",
    summary="Get User Playlists",
    response_description="List of user playlists",
)
@sanitized
@cached("user_playlists", ttl=86400, id_arg="channelId", extra_args=("params",))
async def user_playlists(channelId: str, params: str):
    """
    Retrieve a list of playlists for a given user.

    - **channelId**: YouTube channel ID of the user
    - **params**: params obtained from get_user()
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        executor, partial(get_user_playlists, channelId, params)
    )


@router.get(
    "/user/{channelId}/videos",
    summary="Get User Videos",
    response_description="List of user videos",
)
@sanitized
@cached("user_videos", ttl=86400, id_arg="channelId", extra_args=("params",))
async def user_videos(channelId: str, params: str):
    """
    Retrieve a list of videos for a given user.

    - **channelId**: YouTube channel ID of the user
    - **params**: params obtained from get_user()
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        executor, partial(get_user_videos, channelId, params)
    )


@router.get(
    "/album-browse-id/{audioPlaylistId}",
    summary="Get Album Browse ID",
    response_description="Album browse ID or null",
)
@sanitized
@cached("album_browse_id", ttl=86400, id_arg="audioPlaylistId")
async def album_browse_id(audioPlaylistId: str):
    """
    Get an album's browseId from its audioPlaylistId.

    The audioPlaylistId typically starts with "OLAK5uy_".

    - **audioPlaylistId**: audio playlist ID of the album
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        executor, partial(get_album_browse_id, audioPlaylistId)
    )


@router.get(
    "/album/{browseId}",
    summary="Get Album",
    response_description="Album info and tracks",
)
@sanitized
@cached("album", ttl=86400, id_arg="browseId")
async def album(browseId: str):
    """
    Get information and tracks of an album.

    - **browseId**: browse ID of the album (must start with "MPRE")
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(executor, partial(get_album, browseId))


@router.get(
    "/song/{videoId}",
    summary="Get Song",
    response_description="Song metadata and streaming info",
)
@sanitized
@cached("song", ttl=86400, id_arg="videoId", extra_args=("signatureTimestamp",))
async def song(videoId: str, signatureTimestamp: int | None = None):
    """
    Returns metadata and streaming information about a song or video.

    - **videoId**: video ID of the song
    - **signatureTimestamp**: timestamp of the base.js player (from get_signatureTimestamp)
    """
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        executor, partial(get_song, videoId, signatureTimestamp)
    )
    return _guard_duration(result, videoId)


@router.get(
    "/track/{videoId}",
    summary="Get Enriched Track",
    response_description="Full track payload: metadata, artwork, genre and lyrics",
)
@sanitized
@cached(
    "track",
    ttl=604800,
    id_arg="videoId",
    extra_args=("provider", "lyricsOrder", "lyricsEnabled"),
)
async def track(
    videoId: str,
    provider: str | None = None,
    lyricsOrder: str | None = None,
    lyricsEnabled: str | None = None,
    paxsenixKey: str | None = None,
):
    """
    Returns everything the player needs about a track in one call.

    Payload contains title, artists, album, genre, release year, artwork URL
    and both the synced and unsynced lyrics, plus the ids needed to fetch the
    related songs.

    - **videoId**: video ID of the song
    - **provider**: force a lyrics source — one of ``lrclib``, ``musixmatch``,
      ``netease``, ``megalobiz`` or ``genius`` (legacy syncedlyrics keys),
      or a new chain id (``betterlyrics``, ``youlyplus``, ``kugou``,
      ``simpmusic``, ``unison``, ``paxsenix-apple-music``,
      ``paxsenix-spotify``, ``paxsenix-musixmatch``). Omit it (or pass
      ``auto``) to keep the default resolution chain.
    - **lyricsOrder**: comma-separated chain provider ids, in the order to
      consult them (default: the registry order).
    - **lyricsEnabled**: comma-separated chain provider ids to consult
      (default: all).
    - **paxsenixKey**: Paxsenix API key for the gated providers. It is
      never logged and never part of any cache key.
    """
    if provider in (None, "", "auto"):
        provider = None
    else:
        chain_ids = _chain_provider_ids()
        if (
            provider not in LYRICS_PROVIDERS
            and chain_ids
            and provider not in chain_ids
        ):
            raise HTTPException(
                status_code=400,
                detail=f"unknown lyrics provider {provider!r} "
                f"(expected one of: auto, {', '.join(LYRICS_PROVIDERS)}, "
                f"{', '.join(sorted(chain_ids))})",
            )
    order = _parse_id_list(lyricsOrder)
    _validate_chain_ids(order, "lyricsOrder")
    enabled = _parse_id_list(lyricsEnabled)
    _validate_chain_ids(enabled, "lyricsEnabled")
    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(
            executor,
            partial(
                get_track,
                videoId,
                provider=provider,
                lyrics_order=order,
                lyrics_enabled=set(enabled) if enabled else None,
                paxsenix_key=paxsenixKey,
            ),
        )
    except DurationLimitExceeded as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# Resolved motion-artwork URLs live for a week (Apple CDN links expire);
# "this album has no motion art" is cached for a day so a newly added one
# shows up quickly.
_MOTION_URL_TTL = 7 * 24 * 3600
_MOTION_NONE_TTL = 24 * 3600
_MOTION_NONE = "none"


@router.get(
    "/animated-artwork/{albumId}",
    summary="Get Animated Artwork URL",
    response_description="Direct MP4 URL of the album's motion artwork, or null",
)
@sanitized
async def animated_artwork(albumId: int):
    """
    Resolve an album's animated ("motion") artwork via Apple Music.

    Returns ``{"video_url": <direct mp4 url>}``, or ``{"video_url": null}``
    when the album has no motion artwork **or** Apple rate-limits the lookup
    (the failure is not cached, so it is retried on the next request).

    The resolved URL is cached in Redis for one week under the album id,
    because the underlying CDN link can expire.

    - **albumId**: iTunes collection id of the album
    """
    key = f"yt:motion:{albumId}"
    rds = state.rds

    if rds is not None:
        # Serve from the week-long cache; any Redis hiccup falls through to a
        # fresh resolve (and a failed write just means the next call repeats).
        with suppress(Exception):
            cached_url = await rds.get(key)
            if cached_url is not None:
                value = (
                    cached_url.decode()
                    if isinstance(cached_url, (bytes, bytearray))
                    else str(cached_url)
                )
                return {"video_url": None if value == _MOTION_NONE else value}

    loop = asyncio.get_running_loop()
    try:
        url = await loop.run_in_executor(
            executor, partial(get_animated_artwork, albumId)
        )
    except Exception:  # noqa: BLE001 — rate limit / token / network: null, uncached
        return {"video_url": None}

    if rds is not None:
        with suppress(Exception):
            if url:
                await rds.set(key, url, ex=_MOTION_URL_TTL)
            else:
                await rds.set(key, _MOTION_NONE, ex=_MOTION_NONE_TTL)

    return {"video_url": url}


# Resolved iTunes ids (YT Music album -> iTunes collection) live for a week;
# "no iTunes match" is cached for a day so a newly listed album shows up.
_ITID_TTL = 7 * 24 * 3600
_ITID_NONE_TTL = 24 * 3600
_ITID_NONE = "none"


async def _resolve_cached_itunes_id(key: str, resolver) -> int | None:
    """
    The caching layer shared by the two iTunes-id routes: a week-long Redis
    hit under *key*, a one-day "no match" marker, and deliberately no cache
    for transient failures (auth / network) so the next request retries.

    ``resolver`` is a zero-arg callable run in the thread pool — the CoverPy
    walk is blocking.
    """
    rds = state.rds

    if rds is not None:
        with suppress(Exception):
            cached_id = await rds.get(key)
            if cached_id is not None:
                value = (
                    cached_id.decode()
                    if isinstance(cached_id, (bytes, bytearray))
                    else str(cached_id)
                )
                if value == _ITID_NONE:
                    return None
                try:
                    return int(value)
                except ValueError:
                    pass  # corrupt entry — fall through and re-resolve

    loop = asyncio.get_running_loop()
    try:
        collection_id = await loop.run_in_executor(executor, resolver)
    except Exception:  # noqa: BLE001 — auth / network: null, uncached
        return None

    if rds is not None:
        with suppress(Exception):
            if collection_id:
                await rds.set(key, str(collection_id))
            else:
                await rds.set(key, _ITID_NONE, ex=_ITID_NONE_TTL)

    return collection_id


@router.get(
    "/itunes-id/{albumId}",
    summary="Get iTunes Collection ID",
    response_description="iTunes collection id of the album, or null",
)
@sanitized
async def itunes_id(albumId: str):
    """
    Map a YouTube Music album to its iTunes collection id.

    The client resolves albums itself through the public iTunes Search API,
    but some clients (Safari — iOS *and* macOS — redirects that call to a
    non-CORS ``musics://`` scheme, so the fetch can never succeed). They
    fall back to this endpoint, which does the same "Album - Artist" lookup
    server-side via CoverPy and caches the answer in Redis for one week
    under the album's browse id — so each album is looked up at most once.

    Returns ``{"collection_id": <int>}``, or ``{"collection_id": null}`` when
    the album has no iTunes match **or** the lookup fails transiently (those
    failures are not cached, so the next request retries).

    - **albumId**: the album's YouTube Music browse id (starts with ``MPRE``)
    """
    collection_id = await _resolve_cached_itunes_id(
        f"yt:itid:{albumId}", partial(get_itunes_id, albumId)
    )
    return {"collection_id": collection_id}


@router.get(
    "/itunes-id",
    summary="Get iTunes Collection ID by term",
    response_description="iTunes collection id matching the term, or null",
)
@sanitized
async def itunes_id_by_term(term: str, entity: str = "album"):
    """
    Map a plain search term to its iTunes collection id.

    Same CoverPy lookup as `/itunes-id/{albumId}`, without the browse id —
    the shape flat search / queue records have, where the server only ever
    sees the album *name*. Tracks resolve through ``entity=song``: a song
    search's first result points straight at the collection to animate.

    Cached in Redis for one week under the ``sha256(term\\0entity)`` hash
    ("no match" for a day; transient failures uncached).

    Returns ``{"collection_id": <int>}``, or ``{"collection_id": null}``.

    - **term**: the lookup term, "Title - Artist" style
    - **entity**: ``album`` (default) or ``song``
    """
    if entity not in ("album", "song"):
        raise HTTPException(status_code=422, detail="entity must be 'album' or 'song'")
    term = term.strip()
    if not term:
        raise HTTPException(status_code=422, detail="term must not be empty")

    digest = hashlib.sha256(f"{term}\0{entity}".encode()).hexdigest()
    collection_id = await _resolve_cached_itunes_id(
        f"yt:itlook:{digest}",
        partial(get_itunes_id_by_term, term, entity),
    )
    return {"collection_id": collection_id}


@router.get(
    "/related/{videoId}",
    summary="Get Related Songs",
    response_description="Contextually related tracks for the given song",
)
@sanitized
@cached("related", ttl=86400, id_arg="videoId", extra_args=("limit",))
async def related(videoId: str, limit: int = 25):
    """
    Returns the songs that belong next to the given one: the watch queue
    (what YouTube Music plays after this track), the "Related" watch panel
    and, as a fallback, the radio generated around the seed.

    Tracks longer than one hour are filtered out.

    - **videoId**: video ID used as the seed
    - **limit**: maximum number of tracks to return (default: 25)
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        executor, partial(get_related, videoId, limit)
    )


@router.get(
    "/song/{browseId}/credits",
    summary="Get Song Credits",
    response_description="Song credits info",
)
@sanitized
@cached("song_credits", ttl=86400, id_arg="browseId")
async def song_credits(browseId: str):
    """
    Get credits for a song.

    Returns performed_by, written_by, produced_by, and other credits.

    - **browseId**: browse ID of the song (starts with "MPTC")
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(executor, partial(get_song_credits, browseId))


@router.get(
    "/song/{browseId}/related",
    summary="Get Related Songs",
    response_description="Related content for the song",
)
@sanitized
@cached("song_related", ttl=86400, id_arg="browseId")
async def song_related(browseId: str):
    """
    Gets related content for a song.

    Returns content from the "Related" tab of the watch panel.

    - **browseId**: browse ID of the song
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(executor, partial(get_song_related, browseId))


class LyricsTranslateRequest(BaseModel):
    text: str
    target: str


async def _provider_lyrics(
    videoId: str,
    title: str,
    artist: str,
    album: str,
    duration: int | None,
    lyricsOrder: str | None,
    lyricsEnabled: str | None,
):
    """Picker payload; used only when no Paxsenix key is supplied."""
    order = _parse_id_list(lyricsOrder)
    enabled = _parse_id_list(lyricsEnabled)
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        executor,
        partial(
            get_provider_lyrics,
            videoId,
            title,
            artist,
            album,
            duration,
            order,
            set(enabled) if enabled else None,
            None,
        ),
    )


@router.get(
    "/lyrics/providers",
    summary="Get Lyrics From Every Provider",
    response_description="Per-provider parsed lyrics for the lyrics picker",
)
@sanitized
async def lyrics_providers(
    videoId: str = "",
    title: str = "",
    artist: str = "",
    album: str = "",
    duration: int | None = None,
    lyricsOrder: str | None = None,
    lyricsEnabled: str | None = None,
    paxsenixKey: str | None = None,
):
    """
    Returns every chain provider's parsed lyrics for a track, so the
    client can offer a lyrics picker.

    Each result carries the provider id and display name, whether the
    provider is available for this request, and its parsed synced /
    unsynced lyrics (null when that provider has none). Results follow
    the requested order, deduplicated on identical lyrics.

    Nothing is cached — every request runs the provider chain fresh.

    - **videoId**: YouTube video ID (needed by SimpMusic / Unison)
    - **title** / **artist** / **album**: track metadata for searching
    - **duration**: track length in seconds
    - **lyricsOrder** / **lyricsEnabled**: comma-separated chain ids
    - **paxsenixKey**: Paxsenix API key; never logged
    """
    order = _parse_id_list(lyricsOrder)
    _validate_chain_ids(order, "lyricsOrder")
    enabled = _parse_id_list(lyricsEnabled)
    _validate_chain_ids(enabled, "lyricsEnabled")
    if paxsenixKey:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            executor,
            partial(
                get_provider_lyrics,
                videoId,
                title,
                artist,
                album,
                duration,
                order,
                set(enabled) if enabled else None,
                paxsenixKey,
            ),
        )
    return await _provider_lyrics(
        videoId=videoId,
        title=title,
        artist=artist,
        album=album,
        duration=duration,
        lyricsOrder=lyricsOrder,
        lyricsEnabled=lyricsEnabled,
    )


@router.post(
    "/lyrics/translate",
    summary="Translate Lyrics",
    response_description="Translated lyrics text",
)
@sanitized
async def lyrics_translate(body: LyricsTranslateRequest):
    """
    Translate a lyrics text into another language.

    Only ever called on an explicit user action — never part of the
    default lyrics chain. ``target`` is a 2-3 letter language code
    (``en``, ``ar``, …) or one of the alias names from the Android use
    case (``HEBREW``, ``BURMESE``, …).

    - **text**: lyrics text to translate (lines are translated as segments)
    - **target**: target language code or alias name
    """
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="text must not be empty")
    try:
        from ..lyrics.translate import resolve_language_code
    except Exception:  # noqa: BLE001 — degraded: bare-code validation only
        resolve_language_code = None
    if resolve_language_code is not None:
        code = resolve_language_code(body.target)
    else:
        candidate = body.target.strip().lower()
        code = candidate if 2 <= len(candidate) <= 3 and candidate.isalpha() else None
    if code is None:
        raise HTTPException(
            status_code=400, detail=f"unsupported language {body.target!r}"
        )
    loop = asyncio.get_running_loop()
    try:
        translated = await loop.run_in_executor(
            executor, partial(translate_lyrics, body.text, body.target)
        )
    except Exception as exc:  # noqa: BLE001 — translation service failure
        raise HTTPException(
            status_code=502, detail=f"translation failed: {exc}"
        ) from exc
    return {"translatedText": translated}


@router.get(
    "/lyrics/{browseId}",
    summary="Get Lyrics",
    response_description="Song lyrics or timed lyrics",
)
@sanitized
async def lyrics(browseId: str, timestamps: bool = False):
    """
    Returns lyrics of a song/video.

    - **browseId**: browse ID of the song
    - **timestamps**: return timed lyrics if available (default: false)
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        executor, partial(get_lyrics, browseId, timestamps)
    )


@router.get(
    "/basejs-url",
    summary="Get Base.js URL",
    response_description="URL of the base.js script",
)
@sanitized
@cached("basejs_url", ttl=3600)
async def basejs_url():
    """
    Extract the URL for the base.js script from YouTube Music.

    Used for obtaining signature timestamps.
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(executor, partial(get_basejs_url))


@router.get(
    "/signature-timestamp",
    summary="Get Signature Timestamp",
    response_description="Signature timestamp integer",
)
@sanitized
@cached("signature_timestamp", ttl=3600)
async def signature_timestamp(url: str | None = None):
    """
    Fetch base.js and parse the signatureTimestamp.

    Used with get_song() for streaming data decryption.

    - **url**: URL of the base.js script (fetched automatically if not provided)
    """
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(executor, partial(get_signatureTimestamp, url))
