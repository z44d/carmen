/*
 * Carmen (2026)
 * © z44d — github.com/z44d
 * GPL-3.0 License | Forked from ArchiveTune (https://github.com/rukamori/ArchiveTune)
 */

package moe.rukamori.archivetune.carmen

import android.content.Context
import androidx.datastore.preferences.core.edit
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import moe.rukamori.archivetune.constants.CarmenSuggestionPoolKey
import moe.rukamori.archivetune.utils.dataStore

/**
 * Carmen's quick-picks suggestion pool.
 *
 * Port of the iOS/Home algorithm: on every play, the first 10 related songs
 * of that track are appended to a FIFO pool capped at the last 100 ids; a
 * track the user plays is removed from it. Home shows the 10 most-recent
 * tracks plus a sample of this pool.
 *
 * Stored in DataStore (JSON string array) — no Room schema churn, and the ids
 * resolve through the existing `song` table at read time.
 */
object CarmenSuggestions {
    /** Cap on the pool (FIFO — keep the most recent N). */
    const val POOL_LIMIT = 100

    private val json = Json
    private val serializer = ListSerializer(String.serializer())

    private fun decode(raw: String?): List<String> =
        runCatching { json.decodeFromString(serializer, raw.orEmpty()) }.getOrDefault(emptyList())
            .distinct()

    /** Ordered pool (insertion order — most recent last). */
    fun flow(context: Context): Flow<List<String>> =
        context.dataStore.data.map { prefs -> decode(prefs[CarmenSuggestionPoolKey]) }

    /**
     * Append new ids at the tail (skipping ids already in the pool), then
     * suffix-cap to the last [POOL_LIMIT]. Excluding seeds/played ids is the
     * caller's job (it knows what was just played).
     */
    suspend fun harvest(
        context: Context,
        videoIds: List<String>,
    ) {
        if (videoIds.isEmpty()) return
        context.dataStore.edit { prefs ->
            val current = decode(prefs[CarmenSuggestionPoolKey])
            val seen = current.toHashSet()
            val appended = videoIds.filter { it.isNotBlank() && seen.add(it) }
            if (appended.isEmpty()) return@edit
            val merged = (current + appended).takeLast(POOL_LIMIT)
            prefs[CarmenSuggestionPoolKey] = json.encodeToString(serializer, merged)
        }
    }

    /** Drop ids from the pool (played tracks leave the suggestions). */
    suspend fun remove(
        context: Context,
        videoIds: Collection<String>,
    ) {
        if (videoIds.isEmpty()) return
        context.dataStore.edit { prefs ->
            val current = decode(prefs[CarmenSuggestionPoolKey])
            if (current.isEmpty()) return@edit
            val removed = current.filterNot { it in videoIds }
            if (removed.size == current.size) return@edit
            prefs[CarmenSuggestionPoolKey] = json.encodeToString(serializer, removed)
        }
    }

    /** Shuffle the pool (Home refresh). */
    suspend fun reshuffle(context: Context) {
        context.dataStore.edit { prefs ->
            val current = decode(prefs[CarmenSuggestionPoolKey])
            if (current.size < 2) return@edit
            prefs[CarmenSuggestionPoolKey] = json.encodeToString(serializer, current.shuffled())
        }
    }

    suspend fun clear(context: Context) {
        context.dataStore.edit { prefs ->
            prefs[CarmenSuggestionPoolKey] = "[]"
        }
    }
}
