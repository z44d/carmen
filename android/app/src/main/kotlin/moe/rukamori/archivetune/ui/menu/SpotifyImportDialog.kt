/*
 * Carmen (2026)
 * © Rukamori — github.com/rukamori
 * GPL-3.0 License | Contributors: see git history
 * Do not remove or alter this notice. - Per GPL-3.0 Section 4 & Section 5
 */

package moe.rukamori.archivetune.ui.menu

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import moe.rukamori.archivetune.R
import moe.rukamori.archivetune.carmen.SpotifyMatchStatus
import moe.rukamori.archivetune.carmen.SpotifyTrackConversion
import moe.rukamori.archivetune.carmen.SpotifyTrackInfo
import moe.rukamori.archivetune.ui.component.DefaultDialog
import moe.rukamori.archivetune.viewmodels.SpotifyImportStep
import moe.rukamori.archivetune.viewmodels.SpotifyImportViewModel

/**
 * Spotify playlist import: paste a link, preview the playlist, convert its
 * tracks against YouTube Music through the Carmen server (streamed, one
 * event per track) and save the matches as a local playlist. Android twin
 * of the web `SpotifyImportDialog`.
 */
@Composable
fun SpotifyImportDialog(
    onDismiss: () -> Unit,
    onOpenPlaylist: (String) -> Unit,
    viewModel: SpotifyImportViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val currentOnDismiss by rememberUpdatedState(onDismiss)
    val currentOnOpenPlaylist by rememberUpdatedState(onOpenPlaylist)

    DefaultDialog(
        onDismiss = {
            viewModel.close()
            currentOnDismiss()
        },
        icon = {
            Icon(
                painter = painterResource(R.drawable.spotify_icon),
                contentDescription = null,
                tint = Color.Unspecified,
            )
        },
        title = { Text(text = stringResource(R.string.spotify_import_title)) },
        horizontalAlignment = Alignment.Start,
        contentScrollable =
            state.step == SpotifyImportStep.Preview ||
                state.step == SpotifyImportStep.Results,
        buttons = {
            when (state.step) {
                SpotifyImportStep.Input -> {
                    TextButton(onClick = { currentOnDismiss() }) {
                        Text(text = stringResource(android.R.string.cancel))
                    }
                    TextButton(onClick = viewModel::preview, enabled = state.canPreview) {
                        Text(text = stringResource(R.string.spotify_import_preview))
                    }
                }

                SpotifyImportStep.Loading -> {
                    TextButton(onClick = { currentOnDismiss() }) {
                        Text(text = stringResource(android.R.string.cancel))
                    }
                }

                SpotifyImportStep.Preview -> {
                    TextButton(onClick = { currentOnDismiss() }) {
                        Text(text = stringResource(android.R.string.cancel))
                    }
                    TextButton(onClick = viewModel::convert, enabled = state.canConvert) {
                        Text(text = stringResource(R.string.spotify_import_convert))
                    }
                }

                SpotifyImportStep.Converting -> {
                    TextButton(onClick = viewModel::cancel) {
                        Text(text = stringResource(android.R.string.cancel))
                    }
                }

                SpotifyImportStep.Results -> {
                    TextButton(onClick = { currentOnDismiss() }) {
                        Text(text = stringResource(android.R.string.cancel))
                    }
                    TextButton(onClick = viewModel::save, enabled = state.canSave) {
                        Text(text = stringResource(R.string.spotify_import_save))
                    }
                }

                SpotifyImportStep.Saved -> {
                    state.savedPlaylistId?.let { playlistId ->
                        TextButton(
                            onClick = {
                                currentOnOpenPlaylist(playlistId)
                                currentOnDismiss()
                            },
                        ) {
                            Text(text = stringResource(R.string.spotify_import_open))
                        }
                    }
                    TextButton(onClick = { currentOnDismiss() }) {
                        Text(text = stringResource(R.string.ok_button))
                    }
                }
            }
        },
    ) {
        when (state.step) {
            SpotifyImportStep.Input -> {
                Text(
                    text = stringResource(R.string.spotify_import_subtitle),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(modifier = Modifier.height(16.dp))
                OutlinedTextField(
                    value = state.urlInput,
                    onValueChange = viewModel::onUrlChange,
                    label = { Text(text = stringResource(R.string.spotify_import_url_label)) },
                    placeholder = { Text(text = stringResource(R.string.spotify_import_url_placeholder)) },
                    singleLine = true,
                    enabled = !state.isBusy,
                    isError = state.message != null,
                    modifier = Modifier.fillMaxWidth(),
                )
                state.message?.let { message ->
                    Text(
                        text = message,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(top = 12.dp),
                    )
                }
            }

            SpotifyImportStep.Loading -> {
                CenteredStatus(text = state.message ?: stringResource(R.string.spotify_import_loading)) {
                    CircularProgressIndicator(modifier = Modifier.size(32.dp), strokeWidth = 3.dp)
                }
            }

            SpotifyImportStep.Preview -> {
                state.preview?.let { preview ->
                    PlaylistHeader(
                        artworkUrl = preview.artworkUrl,
                        name = preview.name,
                        subtitle = stringResource(R.string.spotify_import_track_count, preview.trackCount),
                        owner = preview.owner ?: stringResource(R.string.spotify_import_unknown_owner),
                    )
                    Spacer(modifier = Modifier.height(12.dp))
                    Text(
                        text = stringResource(R.string.spotify_import_preview_hint),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(bottom = 8.dp),
                    )
                    preview.tracks.forEach { track ->
                        TrackRow(
                            title = track.name,
                            subtitle = track.byline,
                            selected = false,
                            badge = null,
                            onClick = null,
                        )
                    }
                    state.message?.let { message ->
                        Text(
                            text = message,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                            modifier = Modifier.padding(top = 12.dp),
                        )
                    }
                }
            }

            SpotifyImportStep.Converting -> {
                Column(
                    modifier =
                        Modifier
                            .fillMaxWidth()
                            .padding(vertical = 8.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    LinearProgressIndicator(
                        progress = {
                            if (state.progressTotal > 0) {
                                state.progressDone.toFloat() / state.progressTotal
                            } else {
                                0f
                            }
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(modifier = Modifier.height(12.dp))
                    Text(
                        text =
                            stringResource(
                                R.string.spotify_import_progress,
                                state.progressDone,
                                maxOf(state.progressDone, state.progressTotal),
                            ),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    state.conversions.lastOrNull()?.let { conversion ->
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = conversion.track.name,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }

            SpotifyImportStep.Results -> {
                state.preview?.let { preview ->
                    PlaylistHeader(
                        artworkUrl = preview.artworkUrl,
                        name = preview.name,
                        subtitle =
                            stringResource(
                                R.string.spotify_import_results_subtitle,
                                state.summary?.usable ?: 0,
                                maxOf(state.summary?.total ?: 0, state.conversions.size),
                            ),
                        owner = preview.owner ?: stringResource(R.string.spotify_import_unknown_owner),
                    )
                }
                Spacer(modifier = Modifier.height(8.dp))
                state.summary?.let { summary ->
                    Text(
                        text =
                            stringResource(
                                R.string.spotify_import_results_counts,
                                summary.matched,
                                summary.approximate,
                                summary.notFound + summary.errors,
                            ),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (summary.unusable) {
                        Text(
                            text = stringResource(R.string.spotify_import_results_failed),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                            modifier = Modifier.padding(top = 8.dp),
                        )
                    }
                }
                state.message?.let { message ->
                    Text(
                        text = message,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
                if (state.conversions.any(SpotifyTrackConversion::isSelectable)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.End,
                    ) {
                        TextButton(onClick = { viewModel.setAllSelected(true) }) {
                            Text(text = stringResource(R.string.spotify_import_select_all))
                        }
                        TextButton(onClick = { viewModel.setAllSelected(false) }) {
                            Text(text = stringResource(R.string.spotify_import_clear))
                        }
                    }
                }
                state.conversions.forEach { conversion ->
                    ConversionRow(
                        conversion = conversion,
                        selected = conversion.track.id in state.selectedIds,
                        onToggle = { viewModel.toggle(conversion.track.id) },
                    )
                }
            }

            SpotifyImportStep.Saved -> {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Icon(
                        imageVector = Icons.Rounded.Check,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                    )
                    Text(
                        text = stringResource(R.string.spotify_import_saved_message, state.savedName.orEmpty()),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        }
    }
}

private val SpotifyTrackInfo.byline: String
    get() = listOf(artists, album).filter { it.isNotBlank() }.joinToString(" · ")

@Composable
private fun CenteredStatus(
    text: String,
    indicator: @Composable () -> Unit,
) {
    Column(
        modifier =
            Modifier
                .fillMaxWidth()
                .padding(vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        indicator()
        Spacer(modifier = Modifier.height(16.dp))
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun PlaylistHeader(
    artworkUrl: String?,
    name: String,
    subtitle: String,
    owner: String,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (artworkUrl != null) {
            AsyncImage(
                model = artworkUrl,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier =
                    Modifier
                        .size(56.dp)
                        .clip(RoundedCornerShape(8.dp)),
            )
        } else {
            Box(
                modifier =
                    Modifier
                        .size(56.dp)
                        .clip(RoundedCornerShape(8.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    painter = painterResource(R.drawable.spotify_icon),
                    contentDescription = null,
                    tint = Color.Unspecified,
                )
            }
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = name,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = owner,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun TrackRow(
    title: String,
    subtitle: String,
    selected: Boolean,
    badge: Pair<String, Color>?,
    onClick: (() -> Unit)?,
) {
    Row(
        modifier =
            Modifier
                .fillMaxWidth()
                .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
                .padding(vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(
            selected = selected,
            onClick = onClick,
            enabled = onClick != null,
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle.isNotBlank()) {
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (badge != null) {
            Text(
                text = badge.first,
                style = MaterialTheme.typography.labelSmall,
                color = badge.second,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun ConversionRow(
    conversion: SpotifyTrackConversion,
    selected: Boolean,
    onToggle: () -> Unit,
) {
    val badge =
        when (conversion.status) {
            SpotifyMatchStatus.MATCHED -> null
            SpotifyMatchStatus.APPROXIMATE ->
                stringResource(R.string.spotify_import_status_approximate) to MaterialTheme.colorScheme.tertiary
            SpotifyMatchStatus.NOT_FOUND ->
                stringResource(R.string.spotify_import_status_not_found) to MaterialTheme.colorScheme.error
            SpotifyMatchStatus.ERROR ->
                (conversion.error ?: stringResource(R.string.spotify_import_status_error)) to
                    MaterialTheme.colorScheme.error
        }
    TrackRow(
        title = conversion.track.name,
        subtitle = conversion.track.byline,
        selected = selected,
        badge = badge,
        onClick = if (conversion.isSelectable) onToggle else null,
    )
}
