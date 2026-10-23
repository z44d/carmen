/*
 * Carmen (2026)
 * © Rukamori — github.com/rukamori
 * GPL-3.0 License | Contributors: see git history
 * Do not remove or alter this notice. - Per GPL-3.0 Section 4 & Section 5
 */

package moe.rukamori.archivetune.ads.presentation

import androidx.compose.runtime.Immutable
import androidx.lifecycle.ViewModel
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import moe.rukamori.archivetune.ads.domain.OpenSupportPageUseCase
import moe.rukamori.archivetune.ads.domain.SupportPageOpenResult
import javax.inject.Inject

internal sealed interface SupportCarmenScreenState {
    @Immutable
    data object Loading : SupportCarmenScreenState

    @Immutable
    data object Success : SupportCarmenScreenState

    @Immutable
    data object Empty : SupportCarmenScreenState

    @Immutable
    data class Error(
        val reason: SupportCarmenError,
    ) : SupportCarmenScreenState
}

internal enum class SupportCarmenError {
    PageUnavailable,
}

internal enum class SupportCarmenUiEvent {
    OpenFailed,
}

@HiltViewModel
internal class SupportCarmenViewModel
    @Inject
    constructor(
        private val openSupportPage: OpenSupportPageUseCase,
    ) : ViewModel() {
        private val _screenState =
            MutableStateFlow<SupportCarmenScreenState>(SupportCarmenScreenState.Success)
        val screenState: StateFlow<SupportCarmenScreenState> = _screenState.asStateFlow()

        private val eventChannel = Channel<SupportCarmenUiEvent>(Channel.BUFFERED)
        val events = eventChannel.receiveAsFlow()

        fun onSupportCarmenClick() {
            if (_screenState.value is SupportCarmenScreenState.Loading) return
            _screenState.value = SupportCarmenScreenState.Loading
            when (openSupportPage()) {
                SupportPageOpenResult.Opened -> {
                    _screenState.value = SupportCarmenScreenState.Success
                }

                SupportPageOpenResult.Unavailable -> {
                    _screenState.value =
                        SupportCarmenScreenState.Error(SupportCarmenError.PageUnavailable)
                    eventChannel.trySend(SupportCarmenUiEvent.OpenFailed)
                }
            }
        }
    }
