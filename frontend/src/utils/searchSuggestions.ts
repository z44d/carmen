/**
 * Search suggestion helpers shared by the header pill dropdown.
 *
 * A suggestion entry is either a plain string or an object carrying
 * `text` / `query`. History rows come first (matching what is typed,
 * or all of them while the field is empty), then the server's
 * suggestions — deduped case-insensitively, capped at 8 rows.
 */

/** Display text of one suggestion entry (`""` when it has none). */
export function suggestionTextOf(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const record = entry as Record<string, unknown>;
    const text = record.text || record.query;
    if (typeof text === 'string') return text;
  }
  return '';
}

export interface SuggestionEntry {
  kind: 'history' | 'suggestion';
  text: string;
}

/** Merge history + server suggestions into dropdown rows (max 8). */
export function mergeSuggestionEntries(
  history: string[],
  suggestions: string[],
  needle: string,
): SuggestionEntry[] {
  const query = needle.trim().toLowerCase();
  const seen = new Set<string>();
  const rows: SuggestionEntry[] = [];
  for (const text of history) {
    if (query && !text.toLowerCase().includes(query)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ kind: 'history', text });
  }
  for (const text of suggestions) {
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ kind: 'suggestion', text });
  }
  return rows.slice(0, 8);
}
