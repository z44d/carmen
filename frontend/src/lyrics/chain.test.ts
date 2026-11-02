import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchClientBestLyrics, fetchClientProviderResults } from './chain';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input);
      if (url.includes('lrclib.net')) {
        return jsonResponse([
          {
            trackName: 'Song',
            artistName: 'Artist',
            duration: 100,
            plainLyrics: 'plain',
            syncedLyrics: '[00:01.00]LrcLib line',
          },
        ]);
      }
      if (url.includes('lyrics-api.boidu.dev')) {
        return textResponse(
          '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="00:00:01.000" end="00:00:03.000"><span begin="00:00:01.000" end="00:00:02.000">Bet</span><span begin="00:00:02.000" end="00:00:03.000">ter</span></p></div></body></tt>',
        );
      }
      if (url.includes('lyricsplus.binimum.org')) {
        return jsonResponse({ type: 'line', lyrics: [{ time: 1000, text: 'YouLy line' }] });
      }
      // Every other provider: no match (empty / 404-ish payloads the
      // providers treat as empty, not as failures).
      if (url.includes('unison.boidu.dev')) return jsonResponse({ success: false, data: [] });
      if (url.includes('simpmusic.org')) return jsonResponse({ type: 'error', data: [] });
      if (url.includes('kugou.com')) return jsonResponse({ data: { info: [] } });
      if (url.includes('megalobiz.com')) return textResponse('<html></html>');
      return textResponse('', 404);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('client chain ranking', () => {
  it('prefers the word-synced result over a line-synced one', async () => {
    const best = await fetchClientBestLyrics({
      videoId: 'rank-1',
      title: 'Song',
      artist: 'Artist',
      durationSeconds: 100,
      order: ['lrclib', 'betterlyrics', 'youlyplus'],
    });
    expect(best?.provider).toBe('betterlyrics');
    expect(best?.quality).toBe(2);
  });

  it('breaks quality ties by chain order', async () => {
    const best = await fetchClientBestLyrics({
      videoId: 'rank-2',
      title: 'Song',
      artist: 'Artist',
      durationSeconds: 100,
      order: ['lrclib', 'youlyplus'],
    });
    // Both are line results in this fixture; LrcLib is quality 1,
    // YouLyPlus's v2 line result is quality 1 — the earlier
    // provider wins the tie.
    expect(best?.provider).toBe('lrclib');
  });

  it('returns null when no provider has lyrics', async () => {
    const best = await fetchClientBestLyrics({
      videoId: 'rank-3',
      title: 'Song',
      artist: 'Artist',
      durationSeconds: 100,
      order: ['kugou'],
    });
    expect(best).toBeNull();
  });
});

describe('client chain all-results', () => {
  it('deduplicates identical lyrics and keeps registry order', async () => {
    const entries = await fetchClientProviderResults({
      videoId: 'all-1',
      title: 'Song',
      artist: 'Artist',
      durationSeconds: 100,
      order: ['betterlyrics', 'lrclib', 'youlyplus'],
    });
    const withLyrics = entries.filter((e) => e.synced?.length || e.unsynced?.trim());
    expect(withLyrics.length).toBeGreaterThanOrEqual(2);
    const keys = withLyrics.map((e) => JSON.stringify({ s: e.synced, u: e.unsynced }));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('lists unavailable providers as unavailable with no lyrics', async () => {
    const entries = await fetchClientProviderResults({
      videoId: 'all-2',
      title: 'Song',
      artist: 'Artist',
      durationSeconds: 100,
      order: ['paxsenix-apple-music'],
    });
    expect(entries).toHaveLength(1);
    expect(entries.every((e) => e.available === false)).toBe(true);
  });

  it('runs the YouTube providers in the browser like any other provider', async () => {
    const entries = await fetchClientProviderResults({
      videoId: 'all-4',
      title: 'Song',
      artist: 'Artist',
      durationSeconds: 100,
      order: ['youtube-music', 'youtube-subtitle'],
    });
    // No serverOnly flag remains: both run in the browser. In this
    // fixture the watch page is unreachable, so both are empty —
    // and the subtitle row carries the gated reason.
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.available).toBe(true);
      expect(entry.synced).toBeNull();
      expect(entry.unsynced).toBeNull();
      expect('serverOnly' in entry).toBe(false);
    }
    const subtitle = entries.find((e) => e.provider === 'youtube-subtitle')!;
    expect(subtitle.emptyReason).toBe('gated');
  });

  it('never fetches a Carmen server URL from the lyrics path', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();
    await fetchClientProviderResults({
      videoId: 'all-5',
      title: 'Song',
      artist: 'Artist',
      durationSeconds: 100,
      order: ['betterlyrics', 'lrclib', 'youtube-music', 'youtube-subtitle', 'kugou'],
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const [url] of fetchMock.mock.calls) {
      const href = String(url);
      expect(href).not.toContain('browsing/');
      expect(href).not.toContain('api-carmen');
      expect(href).not.toContain('lyrics/providers');
    }
  });

  it('does not throw when a provider fetch rejects', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch');
    });
    const entries = await fetchClientProviderResults({
      videoId: 'all-3',
      title: 'Song',
      artist: 'Artist',
      durationSeconds: 100,
      order: ['lrclib'],
    });
    expect(Array.isArray(entries)).toBe(true);
  });

  it('marks a provider that answers 403 as failed, not empty', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: string) => {
      if (String(input).includes('simpmusic.org')) {
        return textResponse(
          JSON.stringify({ success: false, error: { code: 403, reason: 'This API is only available to SimpMusic clients' } }),
          403,
        );
      }
      return textResponse('', 404);
    });
    const entries = await fetchClientProviderResults({
      videoId: 'all-7',
      title: 'Song',
      artist: 'Artist',
      durationSeconds: 100,
      order: ['simpmusic'],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].directFailed).toBe(true);
    expect(entries[0].synced).toBeNull();
    expect(entries[0].unsynced).toBeNull();
  });

  it('starts all providers at once instead of pooling: a slow provider cannot starve later ones', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    let release!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementation(() => gate);
    const pending = fetchClientProviderResults({
      videoId: 'all-6',
      title: 'Song',
      artist: 'Artist',
      durationSeconds: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes('lrclib.net'))).toBe(true);
    expect(urls.some((url) => url.includes('megalobiz.com'))).toBe(true);
    expect(urls.some((url) => url.includes('unison.boidu.dev'))).toBe(true);
    release(textResponse('', 404));
    const entries = await pending;
    expect(entries.length).toBeGreaterThan(0);
  });
});
