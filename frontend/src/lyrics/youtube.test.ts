import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  descriptionShelfText,
  extractJsonObject,
  extractVisitorData,
  findLyricsBrowseIds,
  getSubtitleStatus,
  getYoutubeMusicLyrics,
  getYoutubeSubtitleLyrics,
  INNERTUBE_API_KEY,
  postInnertube,
} from './youtube';

type FetchMock = ReturnType<typeof vi.fn>;

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

function watchHtml(playerResponse: unknown, initialData: unknown, visitor = 'Cgtsometestvisitor'): string {
  return [
    '<html><head><script>var ytcfg = {"visitorData":"' + visitor + '"};</script></head><body>',
    `<script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script>`,
    `<script>var ytInitialData = ${JSON.stringify(initialData)};</script>`,
    '</body></html>',
  ].join('');
}

describe('extractJsonObject', () => {
  it('matches braces through string literals', () => {
    const html = 'var ytInitialPlayerResponse = {"a":"}{","b":{"c":1}}; trailing';
    expect(extractJsonObject(html, 'ytInitialPlayerResponse')).toEqual({ a: '}{', b: { c: 1 } });
    expect(extractJsonObject(html, 'missing')).toBeNull();
    expect(extractJsonObject('var x = {"a":', 'x')).toBeNull();
  });

  it('extracts visitorData', () => {
    expect(extractVisitorData('{"visitorData":"CgXYZ123"}')).toBe('CgXYZ123');
    expect(extractVisitorData('{}')).toBeNull();
  });
});

describe('findLyricsBrowseIds / descriptionShelfText', () => {
  it('collects MPLYt browse endpoints in order, deduplicated', () => {
    const payload = {
      contents: [
        { browseEndpoint: { browseId: 'MPLYtAAA' } },
        { browseEndpoint: { browseId: 'UCxxxx' } },
        { browseEndpoint: { browseId: 'MPLYtAAA' } },
        { browseEndpoint: { browseId: 'MPLYtBBB' } },
      ],
    };
    expect(findLyricsBrowseIds(payload)).toEqual(['MPLYtAAA', 'MPLYtBBB']);
  });

  it('reads plain lyrics from a description shelf', () => {
    const payload = {
      contents: {
        musicDescriptionShelfRenderer: {
          description: { runs: [{ text: 'Line one\n' }, { text: 'Line two' }] },
        },
      },
    };
    expect(descriptionShelfText(payload)).toBe('Line one\nLine two');
    expect(descriptionShelfText({})).toBeNull();
  });
});

describe('postInnertube', () => {
  it('posts JSON with the public WEB key and no credentials', async () => {
    fetchMock.mockResolvedValue(textResponse(JSON.stringify({ ok: true })));
    const result = await postInnertube(
      'www.youtube.com',
      'next',
      { videoId: 'v1' },
      { clientName: 'WEB', clientVersion: '2.0', visitorData: 'CgV' },
      undefined,
    );
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://www.youtube.com/youtubei/v1/next?key=${INNERTUBE_API_KEY}&prettyPrint=false`,
    );
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    const body = JSON.parse(String(init.body));
    expect(body.videoId).toBe('v1');
    expect(body.context.client).toEqual({ clientName: 'WEB', clientVersion: '2.0', visitorData: 'CgV' });
  });

  it('returns null on non-2xx and throws on transport failure', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('nope', 403));
    await expect(
      postInnertube('www.youtube.com', 'next', {}, { clientName: 'WEB', clientVersion: '2.0' }),
    ).resolves.toBeNull();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(
      postInnertube('www.youtube.com', 'next', {}, { clientName: 'WEB', clientVersion: '2.0' }),
    ).rejects.toThrow(TypeError);
  });
});

describe('YouTube Subtitle (browser)', () => {
  const playerWithCaptions = {
    playabilityStatus: { status: 'OK' },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { baseUrl: 'https://www.youtube.com/api/timedtext?v=sub1&x=1', languageCode: 'en', kind: 'asr' },
          { baseUrl: 'https://www.youtube.com/api/timedtext?v=sub1&x=2', languageCode: 'en' },
        ],
      },
    },
  };

  it('returns LRC from the manual English track via json3', async () => {
    const json3 = {
      events: [
        { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello ' }, { utf8: 'there' }] },
        { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: 'Second line' }] },
      ],
    };
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('api.allorigins.win')) {
        return textResponse(watchHtml(playerWithCaptions, {}));
      }
      if (url.includes('timedtext')) {
        expect(url).toContain('fmt=json3');
        return textResponse(JSON.stringify(json3));
      }
      throw new TypeError('Failed to fetch');
    });
    const result = await getYoutubeSubtitleLyrics(
      { videoId: 'sub-ok', title: 'Song', artist: 'Artist', album: '', durationSeconds: null },
      undefined,
    );
    expect(result).toBe('[00:00.00]Hello there\n[00:03.00]Second line');
    expect(getSubtitleStatus('sub-ok')).toBe('ok');
    // The manual (non-ASR) track is preferred over the auto track.
    const timedtextCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('timedtext'));
    expect(String(timedtextCall?.[0])).toContain('x=2');
  });

  it('reports no-captions when the player loads but lists no tracks', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('api.allorigins.win')) {
        return textResponse(watchHtml({ playabilityStatus: { status: 'OK' }, captions: {} }, {}));
      }
      throw new TypeError('Failed to fetch');
    });
    const result = await getYoutubeSubtitleLyrics(
      { videoId: 'sub-none', title: 'Song', artist: 'Artist', album: '', durationSeconds: null },
      undefined,
    );
    expect(result).toBeNull();
    expect(getSubtitleStatus('sub-none')).toBe('no-captions');
  });

  it('reports gated when the player response is an error (PoToken/login wall)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('api.allorigins.win')) {
        return textResponse(
          watchHtml({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in' } }, {}),
        );
      }
      throw new TypeError('Failed to fetch');
    });
    const result = await getYoutubeSubtitleLyrics(
      { videoId: 'sub-gated', title: 'Song', artist: 'Artist', album: '', durationSeconds: null },
      undefined,
    );
    expect(result).toBeNull();
    expect(getSubtitleStatus('sub-gated')).toBe('gated');
  });

  it('falls back to the relay + vtt when json3 is empty', async () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nFallback line';
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('api.allorigins.win')) {
        return textResponse(watchHtml(playerWithCaptions, {}));
      }
      if (url.includes('timedtext') && url.includes('fmt=json3')) {
        return textResponse(JSON.stringify({ events: [] }));
      }
      if (url.includes('timedtext') && url.includes('fmt=vtt')) {
        return textResponse(vtt);
      }
      throw new TypeError('Failed to fetch');
    });
    const result = await getYoutubeSubtitleLyrics(
      { videoId: 'sub-vtt', title: 'Song', artist: 'Artist', album: '', durationSeconds: null },
      undefined,
    );
    expect(result).toBe('[00:01.00]Fallback line');
  });
});

describe('YouTube Music (browser)', () => {
  const initialData = {
    contents: [{ browseEndpoint: { browseId: 'MPLYtTEST123' } }],
  };

  it('resolves the browse id and converts timed lines to LRC via the browse POST', async () => {
    const browsePayload = {
      contents: {
        elementRenderer: {
          newElement: {
            type: {
              componentType: {
                model: {
                  timedLyricsModel: {
                    lyricsData: {
                      timedLyricsData: [
                        { cueRange: { startTimeMilliseconds: 0, endTimeMilliseconds: 2000 }, lyricLine: 'First' },
                        { cueRange: { startTimeMilliseconds: 2500, endTimeMilliseconds: 4000 }, lyricLine: 'Second' },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('api.allorigins.win')) {
        return textResponse(watchHtml({}, initialData));
      }
      if (url.includes('youtubei/v1/browse')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body.browseId).toBe('MPLYtTEST123');
        expect(body.context.client.clientName).toBe('ANDROID_MUSIC');
        return textResponse(JSON.stringify(browsePayload));
      }
      throw new TypeError('Failed to fetch');
    });
    const result = await getYoutubeMusicLyrics(
      { videoId: 'music-ok', title: 'Song', artist: 'Artist', album: '', durationSeconds: null },
      undefined,
    );
    expect(result).toBe('[00:00.00]First\n[00:02.50]Second');
  });

  it('falls back to the browse page HTML (plain lyrics) when the POST is CORS-blocked', async () => {
    const browsePage = watchHtml(
      {},
      {
        contents: {
          musicDescriptionShelfRenderer: {
            description: { runs: [{ text: 'Plain lyrics\nsecond verse' }] },
          },
        },
      },
    );
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('youtubei/v1/')) throw new TypeError('Failed to fetch');
      if (url.includes('api.allorigins.win')) {
        const decoded = decodeURIComponent(url.split('url=')[1] ?? '');
        if (decoded.includes('music.youtube.com/browse/')) return textResponse(browsePage);
        return textResponse(watchHtml({}, initialData));
      }
      throw new TypeError('Failed to fetch');
    });
    const result = await getYoutubeMusicLyrics(
      { videoId: 'music-page', title: 'Song', artist: 'Artist', album: '', durationSeconds: null },
      undefined,
    );
    expect(result).toBe('Plain lyrics\nsecond verse');
  });

  it('returns null with no browse id and never touches a Carmen server URL', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('youtubei/v1/')) throw new TypeError('Failed to fetch');
      if (url.includes('api.allorigins.win')) return textResponse(watchHtml({}, {}));
      throw new TypeError('Failed to fetch');
    });
    const result = await getYoutubeMusicLyrics(
      { videoId: 'music-none', title: 'Song', artist: 'Artist', album: '', durationSeconds: null },
      undefined,
    );
    expect(result).toBeNull();
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain('browsing/');
      expect(String(url)).not.toContain('api-carmen');
    }
  });
});
