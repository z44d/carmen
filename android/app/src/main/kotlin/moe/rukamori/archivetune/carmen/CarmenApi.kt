/*
 * Carmen (2026)
 * © z44d — github.com/z44d
 * GPL-3.0 License | Forked from ArchiveTune (https://github.com/rukamori/ArchiveTune)
 */

package moe.rukamori.archivetune.carmen

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import moe.rukamori.archivetune.constants.CarmenServerUrlDefault
import moe.rukamori.archivetune.constants.CarmenServerUrlKey
import moe.rukamori.archivetune.innertube.models.Album
import moe.rukamori.archivetune.innertube.models.AlbumItem
import moe.rukamori.archivetune.innertube.models.Artist
import moe.rukamori.archivetune.innertube.models.ArtistItem
import moe.rukamori.archivetune.innertube.models.PlaylistItem
import moe.rukamori.archivetune.innertube.models.SongItem
import moe.rukamori.archivetune.innertube.models.YTItem
import moe.rukamori.archivetune.innertube.pages.AlbumPage
import moe.rukamori.archivetune.innertube.pages.ArtistPage
import moe.rukamori.archivetune.innertube.pages.ArtistSection
import moe.rukamori.archivetune.innertube.pages.ArtistSectionLayout
import moe.rukamori.archivetune.innertube.pages.HomePage
import moe.rukamori.archivetune.innertube.pages.PlaylistPage
import moe.rukamori.archivetune.utils.dataStore
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import timber.log.Timber
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Client for the Carmen server (`https://api-carmen-v1.syr.qzz.io`).
 *
 * The backend wraps ytmusicapi and answers with deliberately untyped JSON —
 * `artists` is a list of objects here and a plain string there, duration
 * arrives as `duration_seconds` / `duration` / `length`, artwork as
 * `thumbnails` / `thumbnail` / `artwork`. Parsing is therefore defensive and
 * manual (mirroring the iOS `Models.swift`), and every field is optional.
 *
 * Used as the **primary** data source (home, search, related, detail pages and
 * streams); the free YouTube Music APIs serve as a silent secondary so the
 * app keeps working if the server is unreachable.
 */
@Singleton
class CarmenApi
    @Inject
    constructor(
        @ApplicationContext private val context: Context,
    ) {
        private val client: OkHttpClient =
            OkHttpClient
                .Builder()
                .connectTimeout(8, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .build()

        private suspend fun baseUrl(): String {
            val stored = context.dataStore.data.first()[CarmenServerUrlKey]
            return normalize(stored ?: CarmenServerUrlDefault)
        }

        private fun normalize(raw: String?): String {
            var url = raw?.trim().orEmpty()
            if (url.isEmpty()) url = CarmenServerUrlDefault
            if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://$url"
            if (url.endsWith("/")) url = url.dropLast(1)
            return url
        }

        private suspend fun get(
            path: String,
            query: Map<String, String> = emptyMap(),
        ): Result<JsonElement> =
            withContext(Dispatchers.IO) {
                runCatching {
                    val url =
                        baseUrl().toHttpUrlOrNull()
                            ?.newBuilder()
                            ?.apply {
                                addEncodedPathSegments(path.trim('/'))
                                query.forEach { (k, v) -> addQueryParameter(k, v) }
                            }?.build()
                            ?: throw IllegalStateException("Carmen: malformed server url")

                    val request = Request.Builder().url(url).header("Accept", "application/json").build()
                    client.newCall(request).execute().use { response ->
                        if (!response.isSuccessful) throw IllegalStateException("Carmen ${response.code} for $path")
                        val body = response.body?.string().orEmpty()
                        if (body.isBlank()) throw IllegalStateException("Carmen empty body for $path")
                        // GitHub-style endpoints return JSON arrays too; parse generically.
                        Json.parseToJsonElement(body)
                    }
                }.onFailure { throwable ->
                    if (throwable !is kotlinx.coroutines.CancellationException) {
                        Timber.w(throwable, "Carmen request failed: %s", path)
                    }
                }
            }

        // ------------------------------------------------------------------
        // Primitive walkers (backend shapes vary per endpoint)
        // ------------------------------------------------------------------

        private fun JsonElement?.maybeStr(): String? {
            val primitive = this as? JsonPrimitive ?: return null
            return if (primitive.isString || primitive.contentOrNull != null) {
                primitive.content.takeIf { it.isNotBlank() }
            } else {
                null
            }
        }

        private fun JsonElement?.int(): Int? = (this as? JsonPrimitive)?.intOrNull

        private fun JsonElement?.bool(): Boolean? = (this as? JsonPrimitive)?.booleanOrNull

        /** `216` (seconds) or `"3:36"` / `"1:02:03"` → seconds. */
        private fun parseDurationSeconds(value: String?): Int? {
            val trimmed = value?.trim().orEmpty()
            if (trimmed.isEmpty()) return null
            trimmed.toIntOrNull()?.let { return it }
            val parts = trimmed.split(':')
            if (parts.size !in 2..3) return null
            var seconds = 0
            for (part in parts) seconds = seconds * 60 + (part.trim().toIntOrNull() ?: return null)
            return seconds
        }

        /** `["name", {name, id}]` variants → artist list. */
        private fun parseArtists(element: JsonElement?): List<Artist> {
            val array = element as? JsonArray ?: return emptyList()
            return array.mapNotNull { item ->
                when (item) {
                    is JsonPrimitive -> item.content.takeIf { it.isNotBlank() }?.let { Artist(name = it, id = null) }
                    is JsonObject ->
                        item["name"].maybeStr()?.let { Artist(name = it, id = item["id"].maybeStr()) }
                    else -> null
                }
            }
        }

        /** `"Album"` or `{name, id}` → album ref. */
        private fun parseAlbum(element: JsonElement?): Album? =
            when (element) {
                is JsonPrimitive -> element.content.takeIf { it.isNotBlank() }?.let { Album(name = it, id = "") }
                is JsonObject ->
                    element["name"].maybeStr()?.let { Album(name = it, id = element["id"].maybeStr().orEmpty()) }
                else -> null
            }

        private fun isWebP(url: String): Boolean = Regex("\\.webp([?#]|$)").containsMatchIn(url)

        private fun thumbArea(obj: JsonObject): Int {
            val w = obj["width"].int() ?: 0
            val h = obj["height"].int() ?: 0
            return if (w * h != 0) w * h else maxOf(w, h)
        }

        /** Largest usable URL out of any of the thumbnail keys; JPEG preferred over webp. */
        private fun pickArtwork(
            source: JsonObject?,
            vararg keys: String,
        ): String? {
            if (source == null) return null
            val bucket = mutableListOf<JsonObject>()
            for (key in keys) {
                val list = source[key] as? JsonArray ?: continue
                for (item in list) {
                    val obj = item as? JsonObject ?: continue
                    if (obj["url"].maybeStr() != null) bucket.add(obj)
                }
            }
            if (bucket.isEmpty()) return null
            val sorted = bucket.sortedByDescending(::thumbArea)
            sorted.firstOrNull { !isWebP(it["url"]!!.jsonPrimitive.content) }?.let { return it["url"]!!.jsonPrimitive.content }
            return sorted.first()["url"]!!.jsonPrimitive.content
        }

        /** Songs always resolve through the i.ytimg CDN (same rule as iOS/web). */
        private fun cdnArtwork(videoId: String?): String? =
            videoId?.takeIf { it.isNotEmpty() }?.let { "https://i.ytimg.com/vi/$it/maxresdefault.jpg" }

        private fun isSquare544(obj: JsonObject): Boolean {
            val w = obj["width"].int()
            val h = obj["height"].int()
            return w == 544 && h == 544
        }

        /**
         * The server's real song thumbnail: prefer the square 544×544 cover
         * from the track's `thumbnails` list, else the last entry (latest in
         * index). Only when the payload carries no thumbnails at all does the
         * i.ytimg CDN url (`maxresdefault`) take over.
         */
        private fun pickSongArtwork(
            obj: JsonObject,
            videoId: String?,
            keys: Array<out String>,
        ): String? {
            val candidates = mutableListOf<JsonObject>()
            for (key in keys) {
                val list = obj[key] as? JsonArray ?: continue
                for (item in list) {
                    val thumb = item as? JsonObject ?: continue
                    if (thumb["url"].maybeStr().isNullOrBlank()) continue
                    candidates.add(thumb)
                }
            }
            if (candidates.isNotEmpty()) {
                candidates.firstOrNull(::isSquare544)?.let { return it["url"]!!.maybeStr() }
                val last = candidates.last()
                val lastUrl = last["url"]!!.jsonPrimitive.content
                if (!isWebP(lastUrl)) return lastUrl
            }
            return cdnArtwork(videoId)
        }

        // ------------------------------------------------------------------
        // Normalization → core innertube models
        // ------------------------------------------------------------------

        fun elementToSongItem(element: JsonElement): SongItem? {
            val obj = element as? JsonObject ?: return null
            val videoId = obj["videoId"].maybeStr() ?: return null

            val artists = parseArtists(obj["artists"])
            val album = parseAlbum(obj["album"])

            var seconds = obj["duration_seconds"].int()
                ?: obj["durationSeconds"].int()
                ?: obj["lengthSeconds"].int()
            if (seconds == null) {
                seconds = parseDurationSeconds(obj["duration"].maybeStr() ?: obj["length"].maybeStr())
            }

            val thumbnail =
                pickSongArtwork(obj, videoId, arrayOf("thumbnails", "thumbnail", "artwork"))
                    ?: pickArtwork(obj, "thumbnails", "thumbnail", "artwork")
                    ?: ""

            return SongItem(
                id = videoId,
                title = obj["title"].maybeStr().orEmpty().ifBlank { "Unknown title" },
                artists = artists,
                album = album,
                duration = seconds,
                thumbnail = thumbnail,
                explicit = obj["isExplicit"].bool() ?: false,
            )
        }

        /** One heterogeneous API card → the matching core [YTItem]. */
        private fun elementToYTItem(element: JsonElement): YTItem? {
            val obj = element as? JsonObject ?: return null

            val videoId = obj["videoId"].maybeStr()
            val browseId = obj["browseId"].maybeStr()
            val playlistId = obj["playlistId"].maybeStr()
            val resultType = obj["resultType"].maybeStr() ?: obj["type"].maybeStr()
            val title = obj["title"].maybeStr().orEmpty().ifBlank { "Unknown title" }
            val artists = parseArtists(obj["artists"])

            val kind = cardKind(resultType, videoId, browseId, playlistId)
            val artwork = pickArtwork(obj, "thumbnails", "thumbnail", "artwork")

            return when (kind) {
                CardKind.SONG ->
                    SongItem(
                        id = videoId ?: return null,
                        title = title,
                        artists = artists,
                        album = parseAlbum(obj["album"]),
                        duration = obj["duration_seconds"].int() ?: parseDurationSeconds(obj["duration"].maybeStr()),
                        thumbnail =
                            pickSongArtwork(obj, videoId, arrayOf("thumbnails", "thumbnail", "artwork"))
                                ?: artwork.orEmpty(),
                        explicit = obj["isExplicit"].bool() ?: false,
                    )

                CardKind.ALBUM ->
                    AlbumItem(
                        browseId = browseId ?: return null,
                        playlistId = playlistId ?: browseId ?: "",
                        title = title,
                        artists = artists.takeIf { it.isNotEmpty() },
                        year = obj["year"].maybeStr()?.toIntOrNull(),
                        thumbnail = artwork.orEmpty(),
                    )

                CardKind.ARTIST ->
                    ArtistItem(
                        id = browseId ?: return null,
                        title = title,
                        thumbnail = artwork,
                        shuffleEndpoint = null,
                        radioEndpoint = null,
                        subscriberCountText = null,
                    )

                CardKind.PLAYLIST -> {
                    val id =
                        playlistId
                            ?: browseId?.takeIf { it.startsWith("VL") }?.drop(2)
                            ?: return null
                    val author = obj["author"].maybeStr()?.let { Artist(it, id = null) } ?: artists.firstOrNull()?.let { Artist(it.name, id = null) }
                    PlaylistItem(
                        id = id,
                        title = title,
                        author = author,
                        songCountText = obj["itemCount"].int()?.toString(),
                        thumbnail = artwork,
                        playEndpoint = null,
                        shuffleEndpoint = null,
                        radioEndpoint = null,
                    )
                }

                CardKind.UNSUPPORTED -> null
            }
        }

        private enum class CardKind { SONG, ALBUM, ARTIST, PLAYLIST, UNSUPPORTED }

        private fun cardKind(
            resultType: String?,
            videoId: String?,
            browseId: String?,
            playlistId: String?,
        ): CardKind =
            when {
                resultType == "song" || resultType == "video" -> if (videoId != null) CardKind.SONG else CardKind.UNSUPPORTED
                resultType == "album" -> CardKind.ALBUM
                resultType == "artist" -> CardKind.ARTIST
                resultType == "playlist" ->
                    if (playlistId?.startsWith("RD") == true || browseId?.startsWith("VLRD") == true) {
                        CardKind.PLAYLIST
                    } else {
                        CardKind.PLAYLIST
                    }
                browseId?.startsWith("MPRE") == true -> CardKind.ALBUM
                playlistId != null -> CardKind.PLAYLIST
                videoId != null -> CardKind.SONG
                browseId?.startsWith("UC") == true -> CardKind.ARTIST
                else -> CardKind.UNSUPPORTED
            }

        private fun parseYTItemArray(root: JsonElement?): List<YTItem> {
            val arrays: List<JsonElement> =
                when (root) {
                    is JsonArray -> root
                    is JsonObject ->
                        buildList {
                            for (key in listOf("videos", "songs", "albums", "artists", "playlists", "featured", "items", "results")) {
                                addAll((root[key] as? JsonArray).orEmpty())
                            }
                        }
                    else -> emptyList()
                }
            return arrays.mapNotNull(::elementToYTItem)
        }

        // ------------------------------------------------------------------
        // Endpoints
        // ------------------------------------------------------------------

        /** `/search` — filter: "songs" | "videos" | "albums" | "artists" | "playlists" | none. */
        suspend fun search(
            query: String,
            filter: String? = null,
            limit: Int = 100,
        ): Result<List<YTItem>> =
            get(
                "/search",
                buildMap {
                    put("query", query)
                    filter?.let { put("filter", it) }
                    put("limit", limit.toString())
                },
            ).map(::parseYTItemArray)

        /**
         * `/browsing/home` → [HomePage]. The endpoint answers a bare array of
         * named shelves (each `{title, contents|items: [card…]}`); cards are
         * heterogeneous media cards already understood by [elementToYTItem].
         */
        suspend fun home(): Result<HomePage> =
            get("/browsing/home").map { root ->
                val array =
                    ((root as? JsonObject)?.get("sections") as? JsonArray)
                        ?: (root as? JsonArray)
                        ?: JsonArray(emptyList())
                val sections =
                    array.mapNotNull { element ->
                        val obj = element as? JsonObject ?: return@mapNotNull null
                        val items =
                            (((obj["contents"] ?: obj["items"]) as? JsonArray).orEmpty())
                                .mapNotNull(::elementToYTItem)
                        if (items.isEmpty()) return@mapNotNull null
                        HomePage.Section(
                            title = obj["title"].maybeStr().orEmpty().ifBlank { "Suggested" },
                            label = null,
                            thumbnail = null,
                            endpoint = null,
                            items = items,
                        )
                    }
                HomePage(chips = null, sections = sections)
            }

        suspend fun suggestions(query: String): Result<List<String>> =
            get("/search/suggestions", mapOf("query" to query)).map { root ->
                (root as? JsonArray)
                    ?.mapNotNull { (it as? JsonPrimitive)?.content?.takeIf(String::isNotBlank) }
                    ?: emptyList()
            }

        /** `/browsing/related/{videoId}` — always answers `{tracks: [...]}`. */
        suspend fun related(
            videoId: String,
            limit: Int = 25,
        ): Result<List<SongItem>> =
            get("/browsing/related/$videoId", mapOf("limit" to limit.toString())).mapCarmenTracks()

        /** `/watch` — queue continuation / radio builder, `{tracks: [...]}`. */
        suspend fun watch(
            videoId: String? = null,
            playlistId: String? = null,
            radio: Boolean = false,
        ): Result<List<SongItem>> =
            get(
                "/watch",
                buildMap {
                    videoId?.let { put("videoId", it) }
                    playlistId?.let { put("playlistId", it) }
                    if (radio) put("radio", "true")
                },
            ).mapCarmenTracks()

        /** `/browsing/track/{videoId}` — enriched single-track metadata. */
        suspend fun song(videoId: String): Result<SongItem> =
            get("/browsing/track/$videoId").map { root ->
                elementToSongItem(root) ?: throw IllegalStateException("Carmen: track had no videoId")
            }

        /** `/browsing/album/{browseId}` → [AlbumPage]. */
        suspend fun album(browseId: String): Result<AlbumPage> =
            get("/browsing/album/$browseId").map { root ->
                val obj = root.jsonObject
                AlbumPage(
                    album =
                        AlbumItem(
                            browseId = browseId,
                            playlistId = obj["audioPlaylistId"].maybeStr() ?: obj["playlistId"].maybeStr() ?: browseId,
                            title = obj["title"].maybeStr().orEmpty().ifBlank { "Unknown album" },
                            artists = parseArtists(obj["artists"]).takeIf { it.isNotEmpty() },
                            year = obj["year"].maybeStr()?.toIntOrNull(),
                            thumbnail = pickArtwork(obj, "thumbnails", "thumbnail").orEmpty(),
                        ),
                    songs =
                        (((obj["tracks"] ?: obj["items"]) as? JsonArray).orEmpty())
                            .mapNotNull(::elementToSongItem),
                    otherVersions = emptyList(),
                )
            }

        /** `/playlists/{playlistId}` → [PlaylistPage]. */
        suspend fun playlist(playlistId: String): Result<PlaylistPage> =
            get("/playlists/$playlistId").map { root ->
                val obj = root.jsonObject
                PlaylistPage(
                    playlist =
                        PlaylistItem(
                            id = obj["id"].maybeStr() ?: playlistId,
                            title = obj["title"].maybeStr().orEmpty().ifBlank { "Unknown playlist" },
                            author = obj["author"].maybeStr()?.let { Artist(it, id = null) },
                            songCountText = obj["trackCount"].int()?.toString(),
                            thumbnail = pickArtwork(obj, "thumbnails", "thumbnail"),
                            playEndpoint = null,
                            shuffleEndpoint = null,
                            radioEndpoint = null,
                            description = obj["description"].maybeStr(),
                        ),
                    songs =
                        (((obj["tracks"] ?: obj["items"]) as? JsonArray).orEmpty())
                            .mapNotNull(::elementToSongItem),
                    songsContinuation = null,
                    continuation = null,
                )
            }

        /** `/browsing/artist/{channelId}` → [ArtistPage] (shelves become app sections). */
        suspend fun artist(channelId: String): Result<ArtistPage> =
            get("/browsing/artist/$channelId").map { root ->
                val obj = root.jsonObject
                val shelf = { key: String -> ((obj[key] as? JsonObject)?.get("results") as? JsonArray) ?: JsonArray(emptyList()) }
                val songs = shelf("songs").mapNotNull(::elementToSongItem)
                val albums = shelf("albums").mapNotNull(::elementToYTItem)
                val singles = shelf("singles").mapNotNull(::elementToYTItem)

                val sections = mutableListOf<ArtistSection>()
                if (songs.isNotEmpty()) sections.add(ArtistSection("Songs", songs, null, ArtistSectionLayout.LIST))
                if (albums.isNotEmpty()) sections.add(ArtistSection("Albums", albums, null, ArtistSectionLayout.GRID))
                if (singles.isNotEmpty()) sections.add(ArtistSection("Singles", singles, null, ArtistSectionLayout.GRID))

                ArtistPage(
                    artist =
                        ArtistItem(
                            id = channelId,
                            title = obj["name"].maybeStr().orEmpty().ifBlank { "Unknown artist" },
                            thumbnail = pickArtwork(obj, "thumbnails", "thumbnail"),
                            shuffleEndpoint = null,
                            radioEndpoint = null,
                            subscriberCountText = obj["subscribers"].maybeStr(),
                            monthlyListenerCountText = obj["monthlyListeners"].maybeStr(),
                        ),
                    sections = sections,
                    description = obj["description"].maybeStr(),
                )
            }

        /**
         * Direct stream URL for ExoPlayer: `{base}/stream?vidId=…`. The server
         * proxies the audio bytes (with Range support; a sanitized response
         * never carries a googlevideo URL), so the path is handed straight to
         * a plain DataSource.
         */
        suspend fun proxiedStreamUrl(videoId: String): String = "${baseUrl()}/stream?vidId=$videoId"

        /** `/stream?probe=1&vidId=…` → optional human-readable error detail. */
        suspend fun streamError(videoId: String): String? =
            get("/stream", mapOf("vidId" to videoId, "probe" to "1"))
                .getOrNull()
                ?.let { root ->
                    val obj = root as? JsonObject
                    obj?.get("error")?.maybeStr() ?: obj?.get("message")?.maybeStr()
                }

        // ------------------------------------------------------------------
        // Mappers
        // ------------------------------------------------------------------

        private fun Result<JsonElement>.mapCarmenTracks(): Result<List<SongItem>> =
            map { root ->
                val array =
                    ((root as? JsonObject)?.get("tracks") as? JsonArray)
                        ?: (root as? JsonObject)?.get("items") as? JsonArray
                        ?: (root as? JsonArray)
                        ?: JsonArray(emptyList())
                array.mapNotNull(::elementToSongItem)
            }
    }
