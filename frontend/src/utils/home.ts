/**
 * Normalization for the server home feed (`GET /browsing/home`).
 *
 * The response is a JSON list of titled rows, each with a mixed `contents`
 * array of songs (`videoId`), playlists (`playlistId`), albums and artists
 * (`browseId`). Nothing here invents titles or descriptions: a row is kept
 * only when it has a non-empty title and at least one item the existing
 * card classifier (`resolveCard` in `components/MediaCard`) can render;
 * unclassifiable items are dropped, never faked.
 */
import { resolveCard } from '../components/MediaCard';
import type { Track } from '../types/models';
import { normalizeTrack } from './track';

/** One titled suggestion row from the server, ready to render. */
export interface HomeSuggestionRow {
  title: string;
  items: unknown[];
}

/**
 * Keep only renderable rows/items from a `/browsing/home` payload.
 * Anything that is not a list, or a row without a title or without a
 * single classifiable item, yields nothing — the caller falls back to
 * the local feed / empty state instead of showing invented content.
 */
export function normalizeHomeRows(payload: unknown): HomeSuggestionRow[] {
  if (!Array.isArray(payload)) return [];
  const rows: HomeSuggestionRow[] = [];
  for (const entry of payload) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    if (!title || !Array.isArray(record.contents)) continue;
    const items = record.contents.filter((item) => resolveCard(item) !== null);
    if (items.length > 0) rows.push({ title, items });
  }
  return rows;
}

/**
 * The playable songs across all suggestion rows, de-duplicated by video
 * id in first-seen order — the hero carousel's fallback slides when the
 * local feed has no recents.
 */
export function homeRowSongs(rows: HomeSuggestionRow[]): Track[] {
  const seen = new Set<string>();
  const songs: Track[] = [];
  for (const row of rows) {
    for (const item of row.items) {
      const track = normalizeTrack(item);
      if (!track || seen.has(track.videoId)) continue;
      seen.add(track.videoId);
      songs.push(track);
    }
  }
  return songs;
}
