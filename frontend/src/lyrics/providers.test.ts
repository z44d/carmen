import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getProviderRegistry } from './providers';

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function provider(id: string) {
  const registry = await getProviderRegistry();
  const def = registry.find((d) => d.id === id);
  if (!def) throw new Error(`no provider ${id}`);
  return def;
}

describe('LrcLib provider', () => {
  it('queries with exact params and picks the closest duration within 2s', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { trackName: 'Set Fire', artistName: 'Adele', duration: 200, plainLyrics: 'far', syncedLyrics: '[00:01.00]far' },
        { trackName: 'Set Fire to the Rain', artistName: 'Adele', duration: 243, plainLyrics: 'near plain', syncedLyrics: '[00:01.00]near' },
      ]),
    );
    const def = await provider('lrclib');
    const result = await def.getLyrics(
      { videoId: 'x', title: 'Set Fire to the Rain', artist: 'Adele', album: '', durationSeconds: 243 },
      undefined,
    );
    expect(result).toBe('[00:01.00]near');
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.hostname).toBe('lrclib.net');
    expect(url.pathname).toBe('/api/search');
    expect(url.searchParams.get('track_name')).toBe('Set Fire to the Rain');
    expect(url.searchParams.get('artist_name')).toBe('Adele');
    expect(url.searchParams.has('album_name')).toBe(false);
  });

  it('getAll emits at most 5, plain at most once, duration-filtered', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        Array.from({ length: 7 }, (_, i) => ({
          trackName: 'Song',
          artistName: 'Artist',
          duration: 100,
          plainLyrics: `plain ${i}`,
          syncedLyrics: `[00:01.00]synced ${i}`,
        })),
      ),
    );
    const def = await provider('lrclib');
    const results = await def.getAllLyrics(
      { videoId: 'x', title: 'Song', artist: 'Artist', album: '', durationSeconds: 100 },
      undefined,
    );
    expect(results).toHaveLength(5);
    expect(results.filter((r) => r.startsWith('plain'))).toHaveLength(1);
  });
});

describe('KuGou provider', () => {
  it('runs search → hash lyrics search → base64 download with keyword normalisation', async () => {
    const lrc = '[00:01.00]Hello\n[00:05.00]World';
    const encoded = 'WzAwOjAxLjAwXUhlbGxvClswMDowNS4wMF1Xb3JsZA=='; // base64 of `lrc`
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ data: { info: [{ hash: 'abc', duration: 243 }] } }),
      )
      .mockResolvedValueOnce(jsonResponse({ candidates: [{ id: 1, accesskey: 'key1' }] }))
      .mockResolvedValueOnce(jsonResponse({ content: encoded }));
    const def = await provider('kugou');
    const result = await def.getLyrics(
      { videoId: 'x', title: 'Song (Remix)', artist: 'A & B', album: '', durationSeconds: 243 },
      undefined,
    );
    expect(result).toBe(lrc);
    const searchUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(searchUrl.searchParams.get('keyword')).toBe('Song  - A、B');
    const lyricsUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(lyricsUrl.searchParams.get('hash')).toBe('abc');
    const downloadUrl = new URL(String(fetchMock.mock.calls[2][0]));
    expect(downloadUrl.pathname).toBe('/download');
    expect(downloadUrl.searchParams.get('accesskey')).toBe('key1');
  });

  it('propagates a transport failure instead of returning empty', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const def = await provider('kugou');
    await expect(
      def.getLyrics({ videoId: 'x', title: 'Song', artist: 'Artist', album: '', durationSeconds: null }, undefined),
    ).rejects.toThrow();
  });
});

describe('BetterLyrics provider', () => {
  it('tries getLyrics then kugou/getLyrics and unwraps a JSON ttml envelope', async () => {
    const ttml = '<tt><body><p begin="1s">Hi</p></body></tt>';
    fetchMock
      .mockResolvedValueOnce(textResponse(JSON.stringify({ ttml, score: 0.9 })))
      .mockResolvedValueOnce(textResponse('nope'));
    const def = await provider('betterlyrics');
    const result = await def.getLyrics(
      { videoId: 'x', title: 'Song', artist: 'Artist', album: 'Album', durationSeconds: 100 },
      undefined,
    );
    expect(result).toBe(ttml);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe('/getLyrics');
    expect(url.searchParams.get('s')).toBe('Song');
    expect(url.searchParams.get('a')).toBe('Artist');
    expect(url.searchParams.get('al')).toBe('Album');
    expect(url.searchParams.get('d')).toBe('100');
    // No User-Agent header is ever set by the client providers.
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.headers).toBeUndefined();
  });

  it('Portato uses qq/getLyrics only', async () => {
    fetchMock.mockResolvedValue(textResponse('<tt><body><p begin="1s">Hi</p></body></tt>'));
    const def = await provider('betterlyrics-portato');
    await def.getLyrics({ videoId: 'x', title: 'Song', artist: 'Artist', album: '', durationSeconds: null }, undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/qq/getLyrics');
  });
});

describe('Unison provider', () => {
  it('resolves summaries without lyrics via lyrics?v=', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: [{ videoId: 'vid1', id: 9 }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { lyrics: '[00:01.00]Hello' } }));
    const def = await provider('unison');
    const result = await def.getLyrics(
      { videoId: 'x', title: 'Song', artist: 'Artist', album: '', durationSeconds: 100 },
      undefined,
    );
    expect(result).toBe('[00:01.00]Hello');
    const searchUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(searchUrl.pathname).toBe('/lyrics/search');
    expect(searchUrl.searchParams.get('song')).toBe('Song');
    expect(searchUrl.searchParams.get('limit')).toBe('5');
  });
});

describe('Paxsenix providers', () => {
  it('gates on a key, sends Bearer, and scores search candidates', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: '42', name: 'Song', artistName: 'Artist', durationMs: 100000 }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ lyrics: 'plain lyrics' }));
    const def = await provider('paxsenix-apple-music');
    const result = await def.getLyrics(
      { videoId: 'x', title: 'Song', artist: 'Artist', album: '', durationSeconds: 100, paxsenixKey: '  secret  ' },
      undefined,
    );
    expect(result).toBe('plain lyrics');
    const searchInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect((searchInit.headers as Record<string, string>).Authorization).toBe('Bearer secret');
    expect((searchInit.headers as Record<string, string>)['User-Agent']).toBeUndefined();
    const lyricsUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(lyricsUrl.pathname).toBe('/lyrics/applemusic');
    expect(lyricsUrl.searchParams.get('id')).toBe('42');
  });

  it('issues no request without a key', async () => {
    const def = await provider('paxsenix-spotify');
    const result = await def.getLyrics(
      { videoId: 'x', title: 'Song', artist: 'Artist', album: '', durationSeconds: null },
      undefined,
    );
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('YouTube providers', () => {
  it('stay unavailable and return nothing', async () => {
    const registry = await getProviderRegistry();
    const def = registry.find((d) => d.id === 'youtube-subtitle')!;
    expect(def.alwaysUnavailable).toBe(true);
    expect(await def.getLyrics({ videoId: 'x', title: '', artist: '', album: '', durationSeconds: null }, undefined)).toBeNull();
    expect(await def.getAllLyrics({ videoId: 'x', title: '', artist: '', album: '', durationSeconds: null }, undefined)).toEqual([]);
  });
});

describe('CORS relay layer', () => {
  it('BetterLyrics returns relayed lyrics when the direct fetch is CORS-blocked', async () => {
    const ttml = '<tt><body><p begin="1s">Hi</p></body></tt>';
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(textResponse(JSON.stringify({ ttml, score: 0.9 })));
    const def = await provider('betterlyrics');
    const result = await def.getLyrics(
      { videoId: 'x', title: 'Song', artist: 'Artist', album: '', durationSeconds: null },
      undefined,
    );
    expect(result).toBe(ttml);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const relayUrl = String(fetchMock.mock.calls[1][0]);
    expect(relayUrl).toContain('api.allorigins.win/raw?url=');
    expect(new URL(relayUrl).searchParams.get('url')).toContain('lyrics-api.boidu.dev/getLyrics');
    // No secret header travels through the relay.
    const relayInit = fetchMock.mock.calls[1][1] as RequestInit | undefined;
    expect(relayInit?.headers).toBeUndefined();
  });

  it('KuGou runs its whole flow through the relay when direct fetches fail', async () => {
    const lrc = '[00:01.00]Hello';
    const encoded = 'WzAwOjAxLjAwXUhlbGxv'; // base64 of `lrc`
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({ data: { info: [{ hash: 'abc', duration: 100 }] } }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({ candidates: [{ id: 1, accesskey: 'key1' }] }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({ content: encoded }));
    const def = await provider('kugou');
    const result = await def.getLyrics(
      { videoId: 'x', title: 'Song', artist: 'Artist', album: '', durationSeconds: 100 },
      undefined,
    );
    expect(result).toBe(lrc);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    // Calls alternate direct (even indices) / relay (odd indices):
    // each step's direct fetch throws, then the AllOrigins relay
    // answers. Assert the relay calls, not every call after the first.
    const relayCalls = fetchMock.mock.calls.filter((_, index) => index % 2 === 1);
    expect(relayCalls).toHaveLength(3);
    for (const call of relayCalls) {
      expect(String(call[0])).toContain('api.allorigins.win');
    }
    const directCalls = fetchMock.mock.calls.filter((_, index) => index % 2 === 0);
    for (const call of directCalls) {
      expect(String(call[0])).toContain('kugou.com');
    }
  });

  it('Paxsenix never uses a relay: a direct failure fails with no relay URL', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const def = await provider('paxsenix-apple-music');
    await expect(
      def.getLyrics(
        { videoId: 'x', title: 'Song', artist: 'Artist', album: '', durationSeconds: 100, paxsenixKey: 'secret' },
        undefined,
      ),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('allorigins');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('codetabs');
  });
});
