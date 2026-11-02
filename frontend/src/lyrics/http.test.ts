import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchJsonWithRelay, fetchTextWithRelay, relayUrlsFor } from './http';

type FetchMock = ReturnType<typeof vi.fn>;

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

describe('relayUrlsFor', () => {
  it('builds AllOrigins then Codetabs from the full target URL, encoded once', () => {
    const target = 'https://lyrics-api.boidu.dev/getLyrics?s=Adele&artist=X%20Y';
    const urls = relayUrlsFor(target);
    expect(urls.map((entry) => entry.name)).toEqual(['allorigins', 'codetabs']);
    expect(urls[0].url).toBe(`https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`);
    expect(urls[1].url).toBe(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(target)}`);
    // The relay query param decodes back to the exact target, query included.
    expect(new URL(urls[0].url).searchParams.get('url')).toBe(target);
    expect(new URL(urls[1].url).searchParams.get('quest')).toBe(target);
  });
});

describe('fetchTextWithRelay', () => {
  it('uses the direct result when the direct fetch succeeds', async () => {
    fetchMock.mockResolvedValue(textResponse('lyrics'));
    const result = await fetchTextWithRelay('https://example.test/x', { q: 'a b' });
    expect(result).toEqual({ status: 200, text: 'lyrics', via: 'direct' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to AllOrigins when the direct fetch throws (CORS)', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(textResponse('[00:01.00]Hi'));
    const result = await fetchTextWithRelay('https://lyrics-api.boidu.dev/getLyrics', { s: 'Song' });
    expect(result.via).toBe('relay');
    expect(result.relay).toBe('allorigins');
    expect(result.text).toBe('[00:01.00]Hi');
    const relayUrl = String(fetchMock.mock.calls[1][0]);
    expect(relayUrl).toContain('api.allorigins.win/raw?url=');
    expect(new URL(relayUrl).searchParams.get('url')).toContain('/getLyrics?s=Song');
  });

  it('tries Codetabs when AllOrigins fails', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new Error('relay down'))
      .mockResolvedValueOnce(textResponse('via codetabs'));
    const result = await fetchTextWithRelay('https://example.test/x');
    expect(result.via).toBe('relay');
    expect(result.relay).toBe('codetabs');
    expect(String(fetchMock.mock.calls[2][0])).toContain('api.codetabs.com/v1/proxy?quest=');
  });

  it('rethrows the direct error when direct and both relays fail', async () => {
    const directError = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValue(directError);
    await expect(fetchTextWithRelay('https://example.test/x')).rejects.toBe(directError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('uses a relay 2xx when the direct fetch answers non-2xx', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('blocked', 403))
      .mockResolvedValueOnce(textResponse('relayed'));
    const result = await fetchTextWithRelay('https://example.test/x');
    expect(result.via).toBe('relay');
    expect(result.text).toBe('relayed');
  });

  it('returns the direct non-2xx result when the relays also fail to bypass it', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('not found', 404))
      .mockResolvedValueOnce(textResponse('relay error', 502));
    const result = await fetchTextWithRelay('https://example.test/x');
    expect(result).toEqual({ status: 404, text: 'not found', via: 'direct' });
  });

  it('never sends secrets to a relay: headers are stripped to Accept only', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(textResponse('ok'));
    await fetchTextWithRelay('https://example.test/x', undefined, {
      Accept: 'application/json',
      Authorization: 'Bearer secret',
      'X-Api-Key': 'secret',
    });
    const relayInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(relayInit.headers).toEqual({ Accept: 'application/json' });
  });
});

describe('fetchJsonWithRelay', () => {
  it('decodes a relayed JSON body after a direct CORS failure', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({ candidates: [] }));
    const payload = await fetchJsonWithRelay('https://lyrics.kugou.com/search', { ver: 1 });
    expect(payload).toEqual({ candidates: [] });
  });

  it('returns null on a relayed non-2xx / bad JSON', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('not json', 200));
    await expect(fetchJsonWithRelay('https://example.test/x')).resolves.toBeNull();
  });
});
