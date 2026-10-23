/**
 * Fallback (browser / non-Tauri) playlist storage.
 *
 * In the browser build there is no SQLite, so playlist membership is kept in
 * the KV fallback store. These tests pin that behaviour: add/list/remove/
 * move/delete of playlist tracks, plus the Spotify-import save path that
 * depends on it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { memTracks, memKv } = vi.hoisted(() => ({
  memTracks: new Map<string, any>(),
  memKv: new Map<string, unknown>(),
}));

vi.mock('../../services/storage', () => ({
  getTrackRecord: async (videoId: string) => memTracks.get(videoId) ?? null,
  putTrackRecord: async (track: any) => {
    memTracks.set(track.videoId, track);
  },
  deleteTrackRecord: async (videoId: string) => {
    memTracks.delete(videoId);
  },
  kvRead: <T>(key: string, fallback: T): T =>
    (memKv.has(key) ? memKv.get(key) : fallback) as T,
  kvWrite: (key: string, value: unknown): void => {
    memKv.set(key, value);
  },
}));

import type { Track } from '../../types/models';
import { fallbackSet } from './fallback';
import {
  addTrackToPlaylist,
  createPlaylist,
  deletePlaylist,
  listPlaylists,
  listPlaylistTracks,
  moveTrackInPlaylist,
  removeTrackFromPlaylist,
} from './playlists';
import { saveConversionAsPlaylist } from '../../services/spotifyConvert';

function track(videoId: string, title: string, artist = 'Artist'): Track {
  return {
    videoId,
    title,
    artists: [artist],
    artist,
    album: null,
    albumName: '',
    duration: null,
    durationSeconds: null,
    artwork: null,
    year: null,
    releaseDate: null,
    isExplicit: false,
    playlistId: null,
  };
}

function conversionResult(videoId: string, title: string) {
  return {
    spotify: {
      id: videoId,
      title,
      artists: ['Artist'],
      artist: 'Artist',
      album: 'Test Album',
      artwork: null,
      duration_ms: 180000,
      spotify_url: `https://open.spotify.com/track/${videoId}`,
      explicit: false,
    },
    status: 'matched' as const,
    confidence: 0.95,
    match: {
      videoId,
      title,
      artists: [{ name: 'Artist' }],
      duration: '3:00',
      thumbnails: [],
    },
    error: null,
  };
}

beforeEach(() => {
  memTracks.clear();
  memKv.clear();
  fallbackSet('playlists', []);
  fallbackSet('favoriteIds', []);
});

describe('fallback playlist tracks', () => {
  it('adds tracks in order and reports the song count', async () => {
    const playlistId = await createPlaylist('Roadtrip');
    await addTrackToPlaylist(playlistId, track('v1', 'One'));
    await addTrackToPlaylist(playlistId, track('v2', 'Two'));
    await addTrackToPlaylist(playlistId, track('v3', 'Three'));

    const songs = await listPlaylistTracks(playlistId);
    expect(songs.map((s) => s.videoId)).toEqual(['v1', 'v2', 'v3']);

    const lists = await listPlaylists();
    expect(lists.find((p) => p.id === playlistId)?.trackCount).toBe(3);
  });

  it('ignores duplicate adds', async () => {
    const playlistId = await createPlaylist('Dups');
    await addTrackToPlaylist(playlistId, track('v1', 'One'));
    await addTrackToPlaylist(playlistId, track('v1', 'One'));

    expect((await listPlaylistTracks(playlistId)).length).toBe(1);
    const lists = await listPlaylists();
    expect(lists.find((p) => p.id === playlistId)?.trackCount).toBe(1);
  });

  it('removes a track and compacts the order', async () => {
    const playlistId = await createPlaylist('Trim');
    await addTrackToPlaylist(playlistId, track('v1', 'One'));
    await addTrackToPlaylist(playlistId, track('v2', 'Two'));
    await addTrackToPlaylist(playlistId, track('v3', 'Three'));

    await removeTrackFromPlaylist(playlistId, 'v2');
    const songs = await listPlaylistTracks(playlistId);
    expect(songs.map((s) => s.videoId)).toEqual(['v1', 'v3']);

    // Appending after a removal keeps dense ordering.
    await addTrackToPlaylist(playlistId, track('v4', 'Four'));
    expect((await listPlaylistTracks(playlistId)).map((s) => s.videoId)).toEqual([
      'v1',
      'v3',
      'v4',
    ]);
  });

  it('moves a track to a new position', async () => {
    const playlistId = await createPlaylist('Reorder');
    await addTrackToPlaylist(playlistId, track('v1', 'One'));
    await addTrackToPlaylist(playlistId, track('v2', 'Two'));
    await addTrackToPlaylist(playlistId, track('v3', 'Three'));

    await moveTrackInPlaylist(playlistId, 'v3', 0);
    expect((await listPlaylistTracks(playlistId)).map((s) => s.videoId)).toEqual([
      'v3',
      'v1',
      'v2',
    ]);
  });

  it('deleting a playlist drops its membership rows', async () => {
    const playlistId = await createPlaylist('Gone');
    await addTrackToPlaylist(playlistId, track('v1', 'One'));
    await deletePlaylist(playlistId);

    expect(await listPlaylists()).toEqual([]);
    expect(await listPlaylistTracks(playlistId)).toEqual([]);
  });

  it('marks favorites on playlist songs', async () => {
    const playlistId = await createPlaylist('Favs');
    await addTrackToPlaylist(playlistId, track('v1', 'One'));
    fallbackSet('favoriteIds', ['v1']);

    const songs = await listPlaylistTracks(playlistId);
    expect(songs[0]?.isFavorite).toBe(true);
  });

  it('saveConversionAsPlaylist stores every selected match (Spotify import path)', async () => {
    const results = [
      conversionResult('yt1', 'Song One'),
      conversionResult('yt2', 'Song Two'),
      conversionResult('yt3', 'Song Three'),
    ];
    const playlistId = await saveConversionAsPlaylist(results, {
      name: 'My Spotify Mix',
      description: 'Imported from Spotify · "Test Mix Vol. 1"',
      selected: results,
    });

    const songs = await listPlaylistTracks(playlistId);
    expect(songs.map((s) => s.title)).toEqual(['Song One', 'Song Two', 'Song Three']);

    const lists = await listPlaylists();
    expect(lists.find((p) => p.id === playlistId)?.trackCount).toBe(3);
    expect(lists.find((p) => p.id === playlistId)?.description).toContain('Spotify');
  });
});
