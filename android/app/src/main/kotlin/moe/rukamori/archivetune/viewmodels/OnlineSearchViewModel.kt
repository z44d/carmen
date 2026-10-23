/*
 * Carmen (2026)
 * © Rukamori — github.com/rukamori
 * GPL-3.0 License | Contributors: see git history
 * Do not remove or alter this notice. - Per GPL-3.0 Section 4 & Section 5
 */

package moe.rukamori.archivetune.viewmodels

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import moe.rukamori.archivetune.aicontentfilter.FilterAiContentUseCase
import moe.rukamori.archivetune.aicontentfilter.LoadAiContentFilterPolicyUseCase
import moe.rukamori.archivetune.carmen.CarmenApi
import moe.rukamori.archivetune.constants.HideExplicitKey
import moe.rukamori.archivetune.constants.HideVideoKey
import moe.rukamori.archivetune.innertube.YouTube
import moe.rukamori.archivetune.innertube.YouTube.SearchFilter.Companion.FILTER_ALBUM
import moe.rukamori.archivetune.innertube.YouTube.SearchFilter.Companion.FILTER_ARTIST
import moe.rukamori.archivetune.innertube.YouTube.SearchFilter.Companion.FILTER_COMMUNITY_PLAYLIST
import moe.rukamori.archivetune.innertube.YouTube.SearchFilter.Companion.FILTER_FEATURED_PLAYLIST
import moe.rukamori.archivetune.innertube.YouTube.SearchFilter.Companion.FILTER_PODCAST
import moe.rukamori.archivetune.innertube.YouTube.SearchFilter.Companion.FILTER_SONG
import moe.rukamori.archivetune.innertube.YouTube.SearchFilter.Companion.FILTER_VIDEO
import moe.rukamori.archivetune.innertube.models.PlaylistItem
import moe.rukamori.archivetune.innertube.models.SongItem
import moe.rukamori.archivetune.innertube.models.YTItem
import moe.rukamori.archivetune.innertube.models.filterExplicit
import moe.rukamori.archivetune.innertube.models.filterVideo
import moe.rukamori.archivetune.innertube.pages.SearchSummaryPage
import moe.rukamori.archivetune.models.ItemsPage
import moe.rukamori.archivetune.ui.screens.search.OnlineSearchResultArgument
import moe.rukamori.archivetune.ui.screens.search.decodeOnlineSearchQuery
import moe.rukamori.archivetune.utils.dataStore
import moe.rukamori.archivetune.utils.get
import moe.rukamori.archivetune.utils.reportException
import javax.inject.Inject

enum class OnlineSearchSort {
    DEFAULT,
    VIEWS,
}

/** Maps an Innertube search filter to the Carmen server's filter name. */
private fun YouTube.SearchFilter?.toCarmenFilter(): String? =
    when (this) {
        YouTube.SearchFilter.FILTER_SONG -> "songs"
        YouTube.SearchFilter.FILTER_VIDEO -> "videos"
        YouTube.SearchFilter.FILTER_ALBUM -> "albums"
        YouTube.SearchFilter.FILTER_ARTIST -> "artists"
        YouTube.SearchFilter.FILTER_COMMUNITY_PLAYLIST -> "community_playlists"
        YouTube.SearchFilter.FILTER_FEATURED_PLAYLIST -> "featured_playlists"
        else -> null
    }

@HiltViewModel
class OnlineSearchViewModel
    @Inject
    constructor(
        @ApplicationContext val context: Context,
        savedStateHandle: SavedStateHandle,
        private val loadAiContentFilterPolicy: LoadAiContentFilterPolicyUseCase,
        private val filterAiContent: FilterAiContentUseCase,
        private val carmenApi: CarmenApi,
    ) : ViewModel() {
        val query =
            decodeOnlineSearchQuery(
                savedStateHandle.get<String>(OnlineSearchResultArgument).orEmpty(),
            )
        // Songs by default; the other types are reachable from the filter menu.
        val filter = MutableStateFlow<YouTube.SearchFilter?>(YouTube.SearchFilter.FILTER_SONG)
        var summaryPage by mutableStateOf<SearchSummaryPage?>(null)
        val viewStateMap = mutableStateMapOf<String, ItemsPage?>()

        private val allModeFilters =
            listOf(
                FILTER_SONG,
                FILTER_VIDEO,
                FILTER_ALBUM,
                FILTER_ARTIST,
                FILTER_PODCAST,
                FILTER_COMMUNITY_PLAYLIST,
                FILTER_FEATURED_PLAYLIST,
            )
        private var isSummaryLoading = false
        private val loadingFilters = mutableSetOf<String>()

        init {
            viewModelScope.launch {
                filter.collect { selectedFilter ->
                    if (selectedFilter == null) {
                        viewModelScope.launch {
                            loadSummaryIfNeeded()
                        }
                        allModeFilters.forEach { allModeFilter ->
                            viewModelScope.launch {
                                loadFilterIfNeeded(allModeFilter)
                            }
                        }
                    } else {
                        loadFilterIfNeeded(selectedFilter)
                    }
                }
            }
        }

        private suspend fun loadSummaryIfNeeded() {
            if (summaryPage != null || isSummaryLoading) return

            isSummaryLoading = true
            try {
                YouTube
                    .searchSummary(query)
                    .onSuccess {
                        val aiContentFilterPolicy = loadAiContentFilterPolicy()
                        val contentFilteredPage =
                            it
                                .filterExplicit(context.dataStore.get(HideExplicitKey, false))
                                .filterVideo(context.dataStore.get(HideVideoKey, false))
                        summaryPage =
                            contentFilteredPage.copy(
                                summaries =
                                    contentFilteredPage.summaries.mapNotNull { summary ->
                                        summary
                                            .copy(items = filterAiContent(summary.items, aiContentFilterPolicy))
                                            .takeIf { filteredSummary -> filteredSummary.items.isNotEmpty() }
                                    },
                            )
                    }.onFailure {
                        reportException(it)
                    }
            } finally {
                isSummaryLoading = false
            }
        }

        private suspend fun loadFilterIfNeeded(filter: YouTube.SearchFilter) {
            val filterKey = filter.value
            if (viewStateMap.containsKey(filterKey) || !loadingFilters.add(filterKey)) return

            try {
                val aiContentFilterPolicy = loadAiContentFilterPolicy()
                val hideExplicit = context.dataStore.get(HideExplicitKey, false)
                val hideVideo = context.dataStore.get(HideVideoKey, false)

                suspend fun List<YTItem>.filtered() =
                    filterAiContent(
                        distinctBy { it.id }.filterExplicit(hideExplicit).filterVideo(hideVideo),
                        aiContentFilterPolicy,
                    )

                // Carmen API is the primary search source; the free YouTube
                // endpoints are a silent secondary when the server can't answer.
                val carmenFilter = filter.toCarmenFilter()
                val carmenItems =
                    if (carmenFilter == null) {
                        emptyList()
                    } else {
                        runCatching {
                            carmenApi.search(query, carmenFilter).getOrNull().orEmpty().filtered()
                        }.getOrDefault(emptyList())
                    }

                viewStateMap[filterKey] =
                    if (carmenItems.isNotEmpty()) {
                        ItemsPage(carmenItems, null)
                    } else {
                        YouTube
                            .search(query, filter)
                            .getOrElse { throwable ->
                                reportException(throwable)
                                ItemsPage(emptyList(), null)
                            }.let { result ->
                                ItemsPage(result.items.filtered(), result.continuation)
                            }
                    }
            } finally {
                loadingFilters.remove(filterKey)
            }
        }

        fun loadMore() {
            val filter = filter.value?.value
            viewModelScope.launch {
                if (filter == null) return@launch
                val viewState = viewStateMap[filter] ?: return@launch
                val continuation = viewState.continuation
                if (continuation != null) {
                    val searchResult =
                        YouTube.searchContinuation(continuation).getOrNull() ?: return@launch
                    val aiContentFilterPolicy = loadAiContentFilterPolicy()
                    val continuedItems =
                        filterAiContent(
                            searchResult.items
                                .filterExplicit(context.dataStore.get(HideExplicitKey, false))
                                .filterVideo(context.dataStore.get(HideVideoKey, false)),
                            aiContentFilterPolicy,
                        )
                    viewStateMap[filter] =
                        ItemsPage(
                            (viewState.items + continuedItems).distinctBy { it.id },
                            searchResult.continuation,
                        )
                }
            }
        }

        fun sortedItems(
            items: List<YTItem>,
            sort: OnlineSearchSort = OnlineSearchSort.DEFAULT,
        ): List<YTItem> =
            when (sort) {
                OnlineSearchSort.DEFAULT -> {
                    items
                }

                OnlineSearchSort.VIEWS -> {
                    items
                        .withIndex()
                        .sortedWith(
                            compareByDescending<IndexedValue<YTItem>> {
                                when (val item = it.value) {
                                    is SongItem -> item.viewCount
                                    is PlaylistItem -> item.viewCount
                                    else -> null
                                } ?: Long.MIN_VALUE
                            }.thenBy { it.index },
                        ).map { it.value }
                }
            }
    }
