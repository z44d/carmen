/*
 * Carmen (2026)
 * © z44d — github.com/z44d
 * GPL-3.0 License | Forked from ArchiveTune (https://github.com/rukamori/ArchiveTune)
 */

package moe.rukamori.archivetune.carmen

import android.content.Context
import kotlinx.coroutines.flow.first
import moe.rukamori.archivetune.constants.CarmenFallbackKey
import moe.rukamori.archivetune.innertube.models.WatchEndpoint
import moe.rukamori.archivetune.innertube.pages.NextResult
import moe.rukamori.archivetune.utils.dataStore
import kotlin.jvm.Volatile

/**
 * Service-locator bridge so non-injected queue classes
 * ([moe.rukamori.archivetune.playback.queues.YouTubeQueue]) can reach the
 * Carmen fallback. Initialised once from `App.onCreate`.
 */
object CarmenQueueFallback {
    @Volatile
    private var appContext: Context? = null

    private val api: CarmenApi? by lazy {
        appContext?.let { CarmenApi(it) }
    }

    fun init(context: Context) {
        appContext = context.applicationContext
    }

    /**
     * Queue-continuation fallback through `/watch`. Returns null when there is
     * nothing to fall back to (not configured / disabled / empty result) — the
     * original failure is rethrown by the caller then.
     */
    suspend fun next(
        endpoint: WatchEndpoint,
        continuation: String?,
        failure: Throwable,
    ): NextResult? {
        if (continuation != null) return null // only the first page; a server queue ends the radio
        val context = appContext ?: return null
        if (endpoint.videoId == null && endpoint.playlistId == null) return null

        val enabled =
            runCatching {
                context.dataStore.data.first()[CarmenFallbackKey]
            }.getOrNull() ?: true
        if (!enabled) return null

        val client = api ?: return null
        val songs =
            CarmenFallbackPolicy(context).tryFallback(failure) {
                client
                    .watch(
                        videoId = endpoint.videoId,
                        playlistId = endpoint.playlistId,
                        radio = endpoint.videoId != null,
                    ).getOrNull()
            } ?: return null
        if (songs.isEmpty()) return null

        return NextResult(
            title = null,
            items = songs,
            currentIndex = null,
            lyricsEndpoint = null,
            relatedEndpoint = null,
            continuation = null,
            endpoint = endpoint,
        )
    }
}
