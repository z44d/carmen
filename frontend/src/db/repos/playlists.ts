/**
 * Playlists — create / rename / delete, add / remove / reorder songs.
 *
 * Every playlist song is mirrored into `tracks` first, so a playlist stays
 * playable (and displayable) even when the audio was never downloaded.
 */
import type { Playlist, PlaylistSong, Track } from '../../types/models';
import { getTrackRecord } from '../../services/storage';
import { getDb, toBool } from '../connection';
import { fallbackGet, fallbackSet, usingFallback } from './fallback';
import { favoriteIds } from './favorites';
import { mapSongRow, type SongRow } from './rows';
import { ensureTrack, upsertTrack } from './tracks';

const PLAYLIST_SELECT = `
  SELECT p.*, (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS track_count
  FROM playlists p
`;

interface PlaylistRow {
  id: number;
  name: string;
  description: string;
  cover_video_id: string | null;
  is_favorite: number;
  position: number;
  created_at: number;
  updated_at: number;
  track_count: number;
}

function mapPlaylistRow(row: PlaylistRow): Playlist {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    coverVideoId: row.cover_video_id,
    isFavorite: toBool(row.is_favorite),
    position: row.position,
    trackCount: Number(row.track_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Browser-fallback membership rows — the SQL `playlist_tracks` equivalent. */
interface FallbackPlaylistTrack {
  videoId: string;
  position: number;
  addedAt: number;
}

const fallbackTracksKey = (playlistId: number) => `playlist_tracks:${playlistId}`;

function readFallbackTracks(playlistId: number): FallbackPlaylistTrack[] {
  const rows = fallbackGet<FallbackPlaylistTrack[]>(fallbackTracksKey(playlistId), []);
  return [...rows].sort((a, b) => a.position - b.position);
}

function writeFallbackTracks(playlistId: number, rows: FallbackPlaylistTrack[]): void {
  const ordered = rows.map((row, index) => ({ ...row, position: index }));
  fallbackSet(fallbackTracksKey(playlistId), ordered);
  // Keep the card's song count honest in the browser build.
  const lists = fallbackGet<Playlist[]>('playlists', []);
  fallbackSet(
    'playlists',
    lists.map((p) =>
      p.id === playlistId ? { ...p, trackCount: ordered.length, updatedAt: Date.now() } : p,
    ),
  );
}

export async function listPlaylists(): Promise<Playlist[]> {
  if (usingFallback) return fallbackGet<Playlist[]>('playlists', []);
  const db = await getDb();
  const rows = await db.select<PlaylistRow[]>(
    `${PLAYLIST_SELECT} ORDER BY p.position ASC, p.created_at DESC`,
  );
  return rows.map(mapPlaylistRow);
}

export async function getPlaylist(id: number): Promise<Playlist | null> {
  if (usingFallback) {
    return fallbackGet<Playlist[]>('playlists', []).find((p) => p.id === id) ?? null;
  }
  const db = await getDb();
  const rows = await db.select<PlaylistRow[]>(`${PLAYLIST_SELECT} WHERE p.id = $1`, [id]);
  return rows[0] ? mapPlaylistRow(rows[0]) : null;
}

export async function createPlaylist(name: string, description = ''): Promise<number> {
  const now = Date.now();
  if (usingFallback) {
    const list = fallbackGet<Playlist[]>('playlists', []);
    const id = Math.max(0, ...list.map((p) => p.id)) + 1;
    list.unshift({
      id,
      name,
      description,
      coverVideoId: null,
      isFavorite: false,
      position: 0,
      trackCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    fallbackSet('playlists', list);
    return id;
  }
  const db = await getDb();
  const position = await db
    .select<{ n: number }[]>('SELECT COUNT(*) AS n FROM playlists')
    .then((rows) => Number(rows[0]?.n ?? 0));
  const result = await db.execute(
    `INSERT INTO playlists (name, description, position, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [name, description, position, now, now],
  );
  return Number(result.lastInsertId ?? 0);
}

export async function renamePlaylist(id: number, name: string): Promise<void> {
  if (usingFallback) {
    const list = fallbackGet<Playlist[]>('playlists', []).map((p) =>
      p.id === id ? { ...p, name, updatedAt: Date.now() } : p,
    );
    fallbackSet('playlists', list);
    return;
  }
  const db = await getDb();
  await db.execute('UPDATE playlists SET name = $1, updated_at = $2 WHERE id = $3', [
    name,
    Date.now(),
    id,
  ]);
}

export async function setPlaylistDescription(id: number, description: string): Promise<void> {
  if (usingFallback) {
    const list = fallbackGet<Playlist[]>('playlists', []).map((p) =>
      p.id === id ? { ...p, description, updatedAt: Date.now() } : p,
    );
    fallbackSet('playlists', list);
    return;
  }
  const db = await getDb();
  await db.execute(
    'UPDATE playlists SET description = $1, updated_at = $2 WHERE id = $3',
    [description, Date.now(), id],
  );
}

export async function deletePlaylist(id: number): Promise<void> {
  if (usingFallback) {
    fallbackSet(
      'playlists',
      fallbackGet<Playlist[]>('playlists', []).filter((p) => p.id !== id),
    );
    fallbackSet(fallbackTracksKey(id), []);
    return;
  }
  const db = await getDb();
  await db.execute('DELETE FROM playlists WHERE id = $1', [id]);
}

export async function setPlaylistFavorite(id: number, favorite: boolean): Promise<void> {
  if (usingFallback) {
    const list = fallbackGet<Playlist[]>('playlists', []).map((p) =>
      p.id === id ? { ...p, isFavorite: favorite, updatedAt: Date.now() } : p,
    );
    fallbackSet('playlists', list);
    return;
  }
  const db = await getDb();
  await db.execute(
    'UPDATE playlists SET is_favorite = $1, updated_at = $2 WHERE id = $3',
    [favorite ? 1 : 0, Date.now(), id],
  );
}

/** Adds a song (upserting its metadata) at the end of the playlist. */
export async function addTrackToPlaylist(playlistId: number, track: Track): Promise<void> {
  if (usingFallback) {
    await upsertTrack(track);
    const rows = readFallbackTracks(playlistId);
    if (!rows.some((row) => row.videoId === track.videoId)) {
      rows.push({ videoId: track.videoId, position: rows.length, addedAt: Date.now() });
      writeFallbackTracks(playlistId, rows);
    }
    return;
  }
  await upsertTrack(track);
  const db = await getDb();
  const position = await db
    .select<{ n: number | null }[]>(
      'SELECT MAX(position) AS n FROM playlist_tracks WHERE playlist_id = $1',
      [playlistId],
    )
    .then((rows) => Number(rows[0]?.n ?? -1) + 1);
  await db.execute(
    `INSERT INTO playlist_tracks (playlist_id, video_id, position, added_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(playlist_id, video_id) DO NOTHING`,
    [playlistId, track.videoId, position, Date.now()],
  );
}

export async function removeTrackFromPlaylist(playlistId: number, videoId: string): Promise<void> {
  if (usingFallback) {
    writeFallbackTracks(
      playlistId,
      readFallbackTracks(playlistId).filter((row) => row.videoId !== videoId),
    );
    return;
  }
  const db = await getDb();
  await db.execute(
    'DELETE FROM playlist_tracks WHERE playlist_id = $1 AND video_id = $2',
    [playlistId, videoId],
  );
  // Compact the remaining positions so ordering stays dense.
  const rows = await db.select<{ video_id: string }[]>(
    'SELECT video_id FROM playlist_tracks WHERE playlist_id = $1 ORDER BY position ASC',
    [playlistId],
  );
  for (let index = 0; index < rows.length; index += 1) {
    await db.execute(
      'UPDATE playlist_tracks SET position = $1 WHERE playlist_id = $2 AND video_id = $3',
      [index, playlistId, rows[index].video_id],
    );
  }
}

export async function moveTrackInPlaylist(
  playlistId: number,
  videoId: string,
  toPosition: number,
): Promise<void> {
  if (usingFallback) {
    const rows = readFallbackTracks(playlistId);
    const from = rows.findIndex((row) => row.videoId === videoId);
    if (from < 0) return;
    const [moved] = rows.splice(from, 1);
    const target = Math.min(Math.max(toPosition, 0), rows.length);
    rows.splice(target, 0, moved!);
    writeFallbackTracks(playlistId, rows);
    return;
  }
  const db = await getDb();
  const rows = await db.select<{ video_id: string }[]>(
    'SELECT video_id FROM playlist_tracks WHERE playlist_id = $1 ORDER BY position ASC',
    [playlistId],
  );
  const from = rows.findIndex((row) => row.video_id === videoId);
  if (from < 0) return;
  const [moved] = rows.splice(from, 1);
  const target = Math.min(Math.max(toPosition, 0), rows.length);
  rows.splice(target, 0, moved!);
  for (let index = 0; index < rows.length; index += 1) {
    await db.execute(
      'UPDATE playlist_tracks SET position = $1 WHERE playlist_id = $2 AND video_id = $3',
      [index, playlistId, rows[index].video_id],
    );
  }
}

const SONG_JOIN = `
  SELECT t.*, d.audio_path,
         (f.video_id IS NOT NULL) AS is_favorite,
         pt.playlist_id, pt.position
  FROM playlist_tracks pt
  JOIN tracks t ON t.video_id = pt.video_id
  LEFT JOIN downloads d ON d.video_id = t.video_id
  LEFT JOIN favorites f ON f.video_id = t.video_id
`;

/** Playlist songs in stored order (works offline for downloaded tracks). */
export async function listPlaylistTracks(playlistId: number): Promise<PlaylistSong[]> {
  if (usingFallback) {
    const rows = readFallbackTracks(playlistId);
    const favs = new Set(await favoriteIds());
    const songs: PlaylistSong[] = [];
    for (const row of rows) {
      const track = await getTrackRecord(row.videoId);
      if (!track) continue;
      songs.push({
        ...track,
        isFavorite: favs.has(row.videoId),
        isDownloaded: false,
        audioPath: null,
      });
    }
    return songs;
  }
  const db = await getDb();
  const rows = await db.select<SongRow[]>(
    `${SONG_JOIN} WHERE pt.playlist_id = $1 ORDER BY pt.position ASC`,
    [playlistId],
  );
  return rows.map(mapSongRow);
}

/** Ensures a stub track row exists (used before adding unknown songs). */
export async function ensureTrackStub(videoId: string, title: string, artist: string): Promise<void> {
  await ensureTrack(videoId, title, artist);
}
