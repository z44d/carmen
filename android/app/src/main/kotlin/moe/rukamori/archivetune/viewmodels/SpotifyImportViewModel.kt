/*
 * Carmen (2026)
 * © Rukamori — github.com/rukamori
 * GPL-3.0 License | Contributors: see git history
 * Do not remove or alter this notice. - Per GPL-3.0 Section 4 & Section 5
 */

package moe.rukamori.archivetune.viewmodels

import androidx.compose.runtime.Immutable
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import moe.rukamori.archivetune.carmen.CarmenApi
import moe.rukamori.archivetune.carmen.SpotifyConvertSummary
import moe.rukamori.archivetune.carmen.SpotifyLink
import moe.rukamori.archivetune.carmen.SpotifyPlaylistPreview
import moe.rukamori.archivetune.carmen.SpotifyTrackConversion
import moe.rukamori.archivetune.db.MusicDatabase
import moe.rukamori.archivetune.db.entities.PlaylistEntity
import moe.rukamori.archivetune.models.toMediaMetadata
import java.time.LocalDateTime
import javax.inject.Inject

sealed interface SpotifyImportStep {
    data object Input : SpotifyImportStep

    data object Loading : SpotifyImportStep

    data object Preview : SpotifyImportStep

    data object Converting : SpotifyImportStep

    data object Results : SpotifyImportStep

    data object Saved : SpotifyImportStep
}

@Immutable
data class SpotifyImportUiState(
    val step: SpotifyImportStep = SpotifyImportStep.Input,
    val urlInput: String = "",
    val message: String? = null,
    val isBusy: Boolean = false,
    val preview: SpotifyPlaylistPreview? = null,
    val conversions: List<SpotifyTrackConversion> = emptyList(),
    val selectedIds: Set<String> = emptySet(),
    val progressDone: Int = 0,
    val progressTotal: Int = 0,
    val summary: SpotifyConvertSummary? = null,
    val savedPlaylistId: String? = null,
    val savedName: String? = null,
) {
    val canPreview: Boolean
        get() = !isBusy && SpotifyLink.playlistID(urlInput) != null

    val canConvert: Boolean
        get() = !isBusy && preview != null

    val canSave: Boolean
        get() = !isBusy && summary?.unusable != true && selectedIds.isNotEmpty()

    val selectedCount: Int
        get() = selectedIds.size
}

/**
 * Drives the Spotify import dialog: paste a playlist link → preview it via
 * the Carmen server → convert track-by-track over server-sent events →
 * save the matched songs as a local playlist (mirroring the web client's
 * `SpotifyImportDialog` flow).
 */
@HiltViewModel
class SpotifyImportViewModel
    @Inject
    constructor(
        private val api: CarmenApi,
        private val database: MusicDatabase,
    ) : ViewModel() {
        private val mutableState = MutableStateFlow(SpotifyImportUiState())
        val state: StateFlow<SpotifyImportUiState> = mutableState.asStateFlow()

        // Generation token: cancelling a run must never let a stale callback
        // (SSE progress, late Result) overwrite the newer step.
        private var generation = 0
        private var job: Job? = null

        fun onUrlChange(value: String) {
            mutableState.update { it.copy(urlInput = value, message = null) }
        }

        fun preview() {
            val playlistId =
                SpotifyLink.playlistID(mutableState.value.urlInput)
                    ?: run {
                        mutableState.update { it.copy(message = INVALID_LINK_MESSAGE) }
                        return
                    }
            start { token ->
                setBusy(SpotifyImportStep.Loading)
                api.spotifyPlaylistPreview("https://open.spotify.com/playlist/$playlistId").fold(
                    onSuccess = { preview ->
                        ifCurrent(token) {
                            mutableState.update {
                                it.copy(
                                    step = SpotifyImportStep.Preview,
                                    isBusy = false,
                                    preview = preview,
                                    conversions = emptyList(),
                                    selectedIds = emptySet(),
                                    summary = null,
                                )
                            }
                        }
                    },
                    onFailure = { error ->
                        ifCurrent(token) {
                            mutableState.update {
                                it.copy(step = SpotifyImportStep.Input, isBusy = false, message = error.message)
                            }
                        }
                    },
                )
            }
        }

        fun convert() {
            val current = mutableState.value
            val preview = current.preview ?: return
            val url = current.urlInput.trim()
            start { token ->
                setBusy(
                    SpotifyImportStep.Converting,
                    progressTotal = preview.trackCount.coerceAtMost(MAX_CONVERT_TRACKS),
                )
                api.convertSpotifyPlaylist(
                    playlistUrl = url,
                    limit = preview.trackCount,
                    onProgress = { progress ->
                        mutableState.update { state ->
                            if (generation != token) {
                                state
                            } else {
                                state.copy(
                                    conversions = progress.conversions,
                                    progressDone = progress.done,
                                    progressTotal = progress.total,
                                )
                            }
                        }
                    },
                ).fold(
                    onSuccess = { outcome ->
                        ifCurrent(token) {
                            mutableState.update {
                                it.copy(
                                    step = SpotifyImportStep.Results,
                                    isBusy = false,
                                    conversions = outcome.conversions,
                                    summary = outcome.summary,
                                    // Everything usable starts selected, like the web client.
                                    selectedIds =
                                        outcome.conversions
                                            .filter(SpotifyTrackConversion::isSelectable)
                                            .mapTo(HashSet()) { conversion -> conversion.track.id },
                                )
                            }
                        }
                    },
                    onFailure = { error ->
                        ifCurrent(token) {
                            mutableState.update {
                                it.copy(step = SpotifyImportStep.Preview, isBusy = false, message = error.message)
                            }
                        }
                    },
                )
            }
        }

        fun toggle(trackId: String) {
            mutableState.update { state ->
                if (state.step != SpotifyImportStep.Results || state.isBusy) return@update state
                val selected = state.selectedIds.toMutableSet()
                if (!selected.add(trackId)) selected.remove(trackId)
                state.copy(selectedIds = selected)
            }
        }

        fun setAllSelected(selected: Boolean) {
            mutableState.update { state ->
                if (state.step != SpotifyImportStep.Results) return@update state
                state.copy(
                    selectedIds =
                        if (selected) {
                            state.conversions
                                .filter(SpotifyTrackConversion::isSelectable)
                                .mapTo(HashSet()) { it.track.id }
                        } else {
                            emptySet()
                        },
                )
            }
        }

        fun save() {
            val current = mutableState.value
            val preview = current.preview ?: return
            val ordered =
                current.conversions
                    .filter { it.track.id in current.selectedIds && it.song != null }
                    .mapNotNull { it.song }
                    .distinctBy { it.id }
            if (ordered.isEmpty()) return

            start { token ->
                setBusy(SpotifyImportStep.Results)
                try {
                    val playlistId =
                        database.withTransaction {
                            val entity =
                                PlaylistEntity(
                                    name = preview.name,
                                    browseId = null,
                                    isEditable = true,
                                    bookmarkedAt = LocalDateTime.now(),
                                )
                            insert(entity)
                            val playlist = getPlaylistById(entity.id) ?: return@withTransaction null
                            ordered.forEach { song -> insert(song.toMediaMetadata()) }
                            addSongToPlaylist(playlist, ordered.map { it.id })
                            entity.id
                        }
                    ifCurrent(token) {
                        if (playlistId == null) {
                            mutableState.update { it.copy(isBusy = false, message = SAVE_FAILED_MESSAGE) }
                        } else {
                            mutableState.update {
                                it.copy(
                                    step = SpotifyImportStep.Saved,
                                    isBusy = false,
                                    savedPlaylistId = playlistId,
                                    savedName = preview.name,
                                )
                            }
                        }
                    }
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    ifCurrent(token) {
                        mutableState.update {
                            it.copy(isBusy = false, message = error.message ?: SAVE_FAILED_MESSAGE)
                        }
                    }
                }
            }
        }

        /** User backed out mid-run — keep the preview, drop the stream. */
        fun cancel() {
            generation++
            job?.cancel()
            job = null
            mutableState.update {
                it.copy(
                    step = if (it.preview != null) SpotifyImportStep.Preview else SpotifyImportStep.Input,
                    isBusy = false,
                    message = null,
                )
            }
        }

        fun close() {
            generation++
            job?.cancel()
            job = null
            mutableState.value = SpotifyImportUiState(urlInput = mutableState.value.urlInput)
        }

        private fun start(block: suspend (token: Int) -> Unit) {
            if (mutableState.value.isBusy) return
            val token = ++generation
            job?.cancel()
            job =
                viewModelScope.launch {
                    block(token)
                }
        }

        private fun setBusy(
            step: SpotifyImportStep,
            progressTotal: Int = 0,
        ) {
            mutableState.update {
                it.copy(
                    step = step,
                    isBusy = true,
                    message = null,
                    progressDone = 0,
                    progressTotal = progressTotal,
                )
            }
        }

        private inline fun ifCurrent(
            token: Int,
            block: () -> Unit,
        ) {
            if (generation == token) block()
        }

        private companion object {
            const val MAX_CONVERT_TRACKS = 200
            const val INVALID_LINK_MESSAGE = "That doesn't look like a valid Spotify playlist link."
            const val SAVE_FAILED_MESSAGE = "The playlist could not be saved — check the debug log in Settings."
        }
    }
