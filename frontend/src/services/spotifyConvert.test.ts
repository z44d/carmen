/**
 * Unit tests for the Spotify converter client helpers.
 *
 * Covers the pure functions (link parsing, error mapping) — the network
 * calls and the SSE stream are exercised against a stub server in the
 * responsive/browser pass instead.
 */
import { describe, expect, it } from 'vitest';

import { friendlyConvertError, parseSpotifyPlaylistUrl } from './spotifyConvert';

const ID = '37i9dQZF1DXcBWIGoYBM5M';

describe('parseSpotifyPlaylistUrl', () => {
  it.each([
    `https://open.spotify.com/playlist/${ID}`,
    `https://open.spotify.com/playlist/${ID}?si=abc123`,
    `http://open.spotify.com/playlist/${ID}`,
    `https://open.spotify.com/intl-de/playlist/${ID}?si=x`,
    `spotify:playlist:${ID}`,
    ID,
    `  https://open.spotify.com/playlist/${ID}  `,
  ])('accepts %s', (raw) => {
    expect(parseSpotifyPlaylistUrl(raw)).toBe(ID);
  });

  it.each([
    '',
    '   ',
    'not a link',
    'https://open.spotify.com/track/abc123',
    'https://open.spotify.com/album/37i9dQZF1DXcBWIGoYBM5M',
    'https://youtube.com/playlist?list=PL123',
    'spotify:track:abc123',
    'too-short',
  ])('rejects %s', (raw) => {
    expect(parseSpotifyPlaylistUrl(raw)).toBeNull();
  });
});

describe('friendlyConvertError', () => {
  it('explains an unreachable server', () => {
    expect(friendlyConvertError(0, '')).toMatch(/Cannot reach the server/);
  });

  it('tells the user to update an old server on /convert 404s', () => {
    expect(friendlyConvertError(404, 'Not Found: /convert/spotify/playlist')).toMatch(
      /too old for Spotify import/,
    );
  });

  it('explains a missing/private playlist on other 404s', () => {
    expect(friendlyConvertError(404, 'Not Found')).toMatch(/private/);
  });

  it('passes bad-request detail through', () => {
    expect(friendlyConvertError(400, 'Custom detail')).toBe('Custom detail');
  });

  it('treats other 503s as Spotify being busy', () => {
    expect(friendlyConvertError(503, 'rate limited')).toMatch(/busy right now/);
  });

  it('falls back to the raw detail', () => {
    expect(friendlyConvertError(502, 'Bad gateway')).toBe('Bad gateway');
  });
});
