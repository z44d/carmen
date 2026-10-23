/*
 * Carmen (2026)
 * © Rukamori — github.com/rukamori
 * GPL-3.0 License | Contributors: see git history
 * Do not remove or alter this notice. - Per GPL-3.0 Section 4 & Section 5
 */

package moe.rukamori.archivetune.viewmodels

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import moe.rukamori.archivetune.aicontentfilter.FilterAiContentUseCase
import moe.rukamori.archivetune.aicontentfilter.LoadAiContentFilterPolicyUseCase
import moe.rukamori.archivetune.carmen.CarmenApi
import moe.rukamori.archivetune.constants.HideExplicitKey
import moe.rukamori.archivetune.constants.HideVideoKey
import moe.rukamori.archivetune.db.MusicDatabase
import moe.rukamori.archivetune.db.entities.SearchHistory
import moe.rukamori.archivetune.innertube.YouTube
import moe.rukamori.archivetune.innertube.models.YTItem
import moe.rukamori.archivetune.innertube.models.filterExplicit
import moe.rukamori.archivetune.innertube.models.filterVideo
import moe.rukamori.archivetune.utils.dataStore
import moe.rukamori.archivetune.utils.get
import javax.inject.Inject

@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class OnlineSearchSuggestionViewModel
    @Inject
    constructor(
        @ApplicationContext val context: Context,
        private val database: MusicDatabase,
        private val loadAiContentFilterPolicy: LoadAiContentFilterPolicyUseCase,
        private val filterAiContent: FilterAiContentUseCase,
        private val carmenApi: CarmenApi,
    ) : ViewModel() {
        private val query = MutableStateFlow("")
        private val _viewState = MutableStateFlow(SearchSuggestionViewState())
        val viewState = _viewState.asStateFlow()

        init {
            viewModelScope.launch {
                query
                    .flatMapLatest { query ->
                        if (query.isEmpty()) {
                            database.searchHistory().map { history ->
                                SearchSuggestionViewState(
                                    history = history,
                                )
                            }
                        } else {
                            val aiContentFilterPolicy = loadAiContentFilterPolicy()

                            // Carmen API first: server suggestions + matching
                            // song hits; the free YouTube endpoint is a silent
                            // secondary when the server can't answer.
                            val carmenSuggestions = carmenApi.suggestions(query).getOrNull().orEmpty()
                            val carmenItems = carmenApi.search(query, "songs", limit = 12).getOrNull().orEmpty()

                            val ytResult =
                                if (carmenSuggestions.isEmpty() && carmenItems.isEmpty()) {
                                    YouTube.searchSuggestions(query).getOrNull()
                                } else {
                                    null
                                }

                            val suggestedWords: List<String> = carmenSuggestions.ifEmpty { ytResult?.queries.orEmpty() }
                            val recommendedItems: List<YTItem> = carmenItems.ifEmpty { ytResult?.recommendedItems.orEmpty() }

                            database
                                .searchHistory(query)
                                .map { it.take(3) }
                                .map { history ->
                                    SearchSuggestionViewState(
                                        history = history,
                                        suggestions =
                                            suggestedWords.filter { word ->
                                                history.none { it.query == word }
                                            },
                                        items =
                                            filterAiContent(
                                                recommendedItems
                                                    .filterExplicit(
                                                        context.dataStore.get(
                                                            HideExplicitKey,
                                                            false,
                                                        ),
                                                    )
                                                    .filterVideo(context.dataStore.get(HideVideoKey, false)),
                                                aiContentFilterPolicy,
                                            ),
                                    )
                                }
                        }
                    }.collect {
                        _viewState.value = it
                    }
            }
        }

        fun updateQuery(query: String) {
            this.query.value = query
        }

        fun deleteHistory(history: SearchHistory) {
            database.query {
                delete(history)
            }
        }
    }

data class SearchSuggestionViewState(
    val history: List<SearchHistory> = emptyList(),
    val suggestions: List<String> = emptyList(),
    val items: List<YTItem> = emptyList(),
)

private fun Pair<List<String>?, List<YTItem>?>.mapBothOrEmpty(): Pair<List<String>, List<YTItem>> = first.orEmpty() to (second ?: emptyList())
