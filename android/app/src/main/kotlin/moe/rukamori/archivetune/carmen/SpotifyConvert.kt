/*
 * Carmen (2026)
 * © Rukamori — github.com/rukamori
 * GPL-3.0 License | Contributors: see git history
 * Do not remove or alter this notice. - Per GPL-3.0 Section 4 & Section 5
 */

package moe.rukamori.archivetune.carmen

import java.net.URI
import moe.rukamori.archivetune.innertube.models.SongItem

data class SpotifyTrackInfo(
    val id: String,
    val name: String,
    val artists: String,
    val album: String,
    val durationMs: Long,
    val artworkUrl: String?,
)

data class SpotifyPlaylistPreview(
    val id: String,
    val name: String,
    val owner: String?,
    val trackCount: Int,
    val artworkUrl: String?,
    val tracks: List<SpotifyTrackInfo>,
)

enum class SpotifyMatchStatus {
    MATCHED,
    APPROXIMATE,
    NOT_FOUND,
    ERROR,
    ;

    companion object {
        fun fromWire(value: String?): SpotifyMatchStatus =
            when (value) {
                "matched" -> MATCHED
                "approximate" -> APPROXIMATE
                "not_found" -> NOT_FOUND
                else -> ERROR
            }
    }
}

data class SpotifyTrackConversion(
    val track: SpotifyTrackInfo,
    val status: SpotifyMatchStatus,
    val confidence: Int?,
    val song: SongItem?,
    val error: String?,
) {
    val isSelectable: Boolean
        get() = song != null && (status == SpotifyMatchStatus.MATCHED || status == SpotifyMatchStatus.APPROXIMATE)
}

data class SpotifyConvertSummary(
    val total: Int,
    val matched: Int,
    val approximate: Int,
    val notFound: Int,
    val errors: Int,
) {
    val usable: Int
        get() = matched + approximate

    val unusable: Boolean
        get() = total > 0 && usable == 0
}

data class SpotifyConvertProgress(
    val done: Int,
    val total: Int,
    val conversions: List<SpotifyTrackConversion>,
)

data class SpotifyConvertOutcome(
    val summary: SpotifyConvertSummary,
    val conversions: List<SpotifyTrackConversion>,
)

object SpotifyLink {
    private val ID = Regex("^[A-Za-z0-9]{16,64}$")

    /**
     * Accepts a share link (https://open.spotify.com/playlist/<id>...), a link URI
     * (spotify:playlist:<id>) or the bare playlist id — mirroring the web client's rules.
     */
    fun playlistID(input: String): String? {
        val trimmed = input.trim()
        if (trimmed.isEmpty()) return null
        if (ID.matches(trimmed)) return trimmed

        if (trimmed.startsWith("spotify:playlist:")) {
            val id = trimmed.removePrefix("spotify:playlist:")
            if ('?' in id || '&' in id || '/' in id) return null
            return if (ID.matches(id)) id else null
        }

        if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return null
        val url =
            runCatching { URI(trimmed).toURL() }
                .getOrNull() ?: return null
        if (url.host?.substringAfterLast('.') != "spotify.com") return null
        val segments = url.path.trim('/').split('/')
        if (segments.size < 3 || segments[segments.size - 2] != "playlist") return null
        val id = segments.last()
        return if (ID.matches(id)) id else null
    }
}
