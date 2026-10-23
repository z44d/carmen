/*
 * Carmen (2026)
 * © z44d — github.com/z44d
 * GPL-3.0 License | Forked from ArchiveTune (https://github.com/rukamori/ArchiveTune)
 */

package moe.rukamori.archivetune.carmen

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import moe.rukamori.archivetune.constants.CarmenFallbackKey
import moe.rukamori.archivetune.utils.dataStore
import timber.log.Timber
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Gate for the Carmen-server fallback: when YouTube Music endpoints fail, the
 * app transparently retires through the Carmen server so no-login playback
 * keeps working. Enabled by default; Settings → Internet can turn it off.
 */
@Singleton
class CarmenFallbackPolicy
    @Inject
    constructor(
        @ApplicationContext private val context: Context,
    ) {
        val enabledFlow: Flow<Boolean> = enabledFlowInternal()

        private fun enabledFlowInternal(): Flow<Boolean> =
            context.dataStore.data
                .map { prefs -> prefs[CarmenFallbackKey] ?: true }
                .distinctUntilChanged()

        suspend fun isEnabled(): Boolean = enabledFlow.first()

        /** Run the Carmen fallback [block] if enabled; returns null when the fallback is off or also fails. */
        suspend fun <T> tryFallback(
            failure: Throwable,
            block: suspend () -> T,
        ): T? {
            if (!isEnabled()) return null
            Timber.i("YouTube Music failed (%s), engaging Carmen fallback", failure.message ?: failure.javaClass.simpleName)
            return runCatching { block() }
                .onFailure { throwable ->
                    if (throwable is kotlinx.coroutines.CancellationException) throw throwable
                    Timber.w(throwable, "Carmen fallback failed")
                }
                .getOrNull()
        }
    }
