/**
 * Tests for the `/browsing/home` response normalization — the shapes below
 * mirror the live payload (a song row, a playlist row, plus malformed
 * entries that must be dropped, never rendered or invented).
 */
import { describe, expect, it } from 'vitest';

import { homeRowSongs, normalizeHomeRows } from './home';

const SONG = {
  videoId: 'abc123',
  title: 'Test Song',
  artists: [{ name: 'Test Artist', id: 'UCtest' }],
  album: { name: 'Test Album', id: 'MPREtest' },
  duration: '3:30',
  thumbnails: [{ url: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg', width: 60, height: 60 }],
};

const PLAYLIST = {
  title: 'Throwbacks',
  playlistId: 'PLtest',
  thumbnails: [{ url: 'https://example.com/p.jpg', width: 60, height: 60 }],
};

const ARTIST = {
  browseId: 'UCartist',
  title: 'An Artist',
  thumbnails: [{ url: 'https://example.com/a.jpg', width: 60, height: 60 }],
};

describe('normalizeHomeRows', () => {
  it('keeps titled rows with classifiable items, in order', () => {
    const rows = normalizeHomeRows([
      { title: 'Quick picks', contents: [SONG, PLAYLIST] },
      { title: 'Artists', contents: [ARTIST] },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe('Quick picks');
    expect(rows[0].items).toHaveLength(2);
    expect(rows[1].items).toHaveLength(1);
  });

  it('drops rows without a title, without contents, or with only junk', () => {
    const rows = normalizeHomeRows([
      { title: '  ', contents: [SONG] },
      { title: 'No contents' },
      { title: 'Junk only', contents: [{ nope: true }, 'text', null] },
      null,
      'not an object',
    ]);
    expect(rows).toEqual([]);
  });

  it('drops unclassifiable items but keeps their row', () => {
    const rows = normalizeHomeRows([{ title: 'Mixed', contents: [{ nope: 1 }, SONG] }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].items).toEqual([SONG]);
  });

  it('returns [] for non-list payloads', () => {
    expect(normalizeHomeRows(null)).toEqual([]);
    expect(normalizeHomeRows({ title: 'x' })).toEqual([]);
    expect(normalizeHomeRows('nope')).toEqual([]);
  });
});

describe('homeRowSongs', () => {
  it('collects only songs, de-duplicated by video id', () => {
    const rows = normalizeHomeRows([
      { title: 'Quick picks', contents: [SONG, PLAYLIST, SONG] },
      { title: 'More', contents: [{ ...SONG, videoId: 'def456', title: 'Second' }] },
    ]);
    const songs = homeRowSongs(rows);
    expect(songs.map((song) => song.videoId)).toEqual(['abc123', 'def456']);
    expect(songs[0].title).toBe('Test Song');
  });

  it('returns [] when rows hold no songs', () => {
    expect(homeRowSongs(normalizeHomeRows([{ title: 'Lists', contents: [PLAYLIST] }]))).toEqual(
      [],
    );
  });
});
