/**
 * YouTube providers, running entirely in the browser.
 *
 * Both providers read the same public web surfaces a browser tab
 * itself uses — no API server, no credentials, no PoToken minting:
 *
 * 1. The watch page (`https://www.youtube.com/watch?v=…`), fetched
 *    as GET through the relay layer, embeds `ytInitialPlayerResponse`
 *    (caption tracks for Subtitle) and `ytInitialData` (the `next`
 *    response, which carries the lyrics browse id for Music).
 * 2. Innertube `youtubei/v1/*` POSTs with the public WEB client.
 *    The API key below is the public web-client key YouTube ships
 *    in every watch page's `ytcfg` (`INNERTUBE_API_KEY`) — it is
 *    not a secret and identifies no account. The request is a
 *    plain `fetch` POST: whether a foreign origin may *read* the
 *    response is decided by YouTube's `Access-Control-Allow-Origin`
 *    header, which cannot be verified from this sandbox (its egress
 *    IP is 403-blocked by Google and its headless browser cannot
 *    complete TLS to YouTube). The code tries the direct POST first
 *    and falls through to the GET paths below when the browser
 *    blocks it — on a real phone the direct path is what decides
 *    whether timed YouTube Music lyrics appear. This is reported
 *    honestly as unverified, never claimed as proven.
 * 3. GET fallbacks through the relay layer: the caption track's own
 *    timedtext URL (Subtitle) and the music browse page HTML
 *    (Music, plain lyrics only).
 *
 * `visitorData` is the anonymous session id the watch page itself
 * publishes in its `ytcfg` (`"visitorData":"…"`) and in the
 * `X-Goog-Visitor-Id` the web client sends. It is read from the
 * watch page (or a previous run's localStorage copy) and included
 * in Innertube POSTs exactly as the web client does. It is not a
 * credential, is never invented, and is never sent anywhere except
 * YouTube's own endpoints.
 *
 * PoToken: the Android subtitle path mints BotGuard PoTokens inside
 * the signed-in player session. No equivalent exists in a browser.
 * The subtitle provider therefore attempts the unauthenticated
 * player-response path first; when the player response reports the
 * video as gated (login/PoToken required), the row is labelled
 * "Not available on web" instead of pretending there are no
 * captions. When the player loads fine but lists no caption tracks,
 * the label is "No captions for this video".
 */
import { captionsToLrc, parseJson3Captions, parseWebVtt, type CaptionLine } from './captions';
import { fetchText, fetchTextWithRelay, parseJsonLenient } from './http';

export interface YoutubeQuery {
  videoId: string;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number | null;
}

/** Public WEB client key shipped in every YouTube watch page. Not a secret. */
export const INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const WEB_CLIENT = { clientName: 'WEB', clientVersion: '2.20240111.09.00' };
const ANDROID_MUSIC_CLIENT = { clientName: 'ANDROID_MUSIC', clientVersion: '7.21.50' };
const VISITOR_DATA_KEY = 'carmen.ytVisitorData';
const TIMED_LYRICS_PATH = [
  'contents',
  'elementRenderer',
  'newElement',
  'type',
  'componentType',
  'model',
  'timedLyricsModel',
  'lyricsData',
] as const;

export type SubtitleStatus = 'no-captions' | 'gated' | 'ok';

const subtitleStatusByVideo = new Map<string, SubtitleStatus>();

/** Last observed subtitle outcome for a video, for the picker's reason label. */
export function getSubtitleStatus(videoId: string): SubtitleStatus | undefined {
  return subtitleStatusByVideo.get(videoId);
}

function cleanQuery(query: YoutubeQuery): YoutubeQuery {
  return {
    videoId: query.videoId ?? '',
    title: (query.title ?? '').trim(),
    artist: (query.artist ?? '').trim(),
    album: (query.album ?? '').trim(),
    durationSeconds: query.durationSeconds ?? null,
  };
}

// ── Watch page ─────────────────────────────────────────────────────────────

/** Session memo of watch-page HTML fetches (one per video id). */
const watchPageCache = new Map<string, Promise<string | null>>();

function fetchWatchPage(videoId: string, signal?: AbortSignal): Promise<string | null> {
  const cached = watchPageCache.get(videoId);
  if (cached) return cached;
  const promise = (async () => {
    const { status, text } = await fetchTextWithRelay(
      'https://www.youtube.com/watch',
      { v: videoId },
      undefined,
      signal,
    );
    // Transport failures THROW out of here (fetchTextWithRelay
    // rethrows when direct + relays all fail) so the chain marks
    // the YouTube providers failed instead of "gated": a 429 from
    // a shared relay IP is not a gated video. Only an answered
    // non-2xx / empty body returns null.
    if (status < 200 || status > 299 || !text.trim()) return null;
    return text;
  })();
  watchPageCache.set(videoId, promise);
  void promise.then(
    (html) => {
      if (!html) watchPageCache.delete(videoId);
    },
    () => {
      watchPageCache.delete(videoId);
    },
  );
  return promise;
}

/**
 * Extract the JSON object assigned after *marker* in page HTML
 * (`var ytInitialPlayerResponse = {...};`). Brace-matching is
 * string-aware so braces inside string literals do not end the scan.
 * Returns `null` when the marker or a balanced object is absent.
 */
export function extractJsonObject(html: string, marker: string): Record<string, unknown> | null {
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return null;
  const openIndex = html.indexOf('{', markerIndex + marker.length);
  if (openIndex === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIndex; i < html.length; i++) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const parsed = parseJsonLenient(html.slice(openIndex, i + 1));
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      }
    }
  }
  return null;
}

/** Anonymous `visitorData` published by the watch page's `ytcfg`. */
export function extractVisitorData(html: string): string | null {
  const match = /"visitorData"\s*:\s*"([^"]+)"/.exec(html);
  return match ? match[1] : null;
}

let visitorData: string | null = null;

function loadVisitorData(): string | null {
  if (visitorData) return visitorData;
  try {
    visitorData = window.localStorage.getItem(VISITOR_DATA_KEY);
  } catch {
    visitorData = null;
  }
  return visitorData;
}

function rememberVisitorData(html: string): void {
  const found = extractVisitorData(html);
  if (!found) return;
  visitorData = found;
  try {
    window.localStorage.setItem(VISITOR_DATA_KEY, found);
  } catch {
    /* storage is a bonus, not a requirement */
  }
}

// ── Innertube POST ─────────────────────────────────────────────────────────

interface InnertubeClient {
  clientName: string;
  clientVersion: string;
  visitorData?: string;
}

/**
 * POST to an Innertube endpoint and decode the JSON body, or `null`
 * on a non-2xx status / bad JSON. Throws only on transport errors
 * (including a CORS rejection — the browser throws `TypeError`
 * before the app ever sees a response), so callers can fall through
 * to the GET paths. `credentials: 'omit'`: no account, no cookies.
 */
export async function postInnertube(
  host: string,
  endpoint: string,
  body: Record<string, unknown>,
  client: InnertubeClient,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const url = `https://${host}/youtubei/v1/${endpoint}?key=${INNERTUBE_API_KEY}&prettyPrint=false`;
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, context: { client } }),
    signal,
  });
  if (response.status < 200 || response.status > 299) return null;
  const text = await response.text();
  const payload = parseJsonLenient(text);
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function dig(node: unknown, path: readonly string[]): unknown {
  let current: unknown = node;
  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function findTimedLines(node: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(node)) {
    if (
      node.length &&
      typeof node[0] === 'object' &&
      node[0] !== null &&
      ('cueRange' in node[0] || 'lyricLine' in node[0])
    ) {
      return node as Record<string, unknown>[];
    }
    for (const item of node) {
      const found = findTimedLines(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === 'object' && node !== null) {
    for (const key of ['timedLyricsData', 'timedLyrics', 'lyricsData']) {
      const value = (node as Record<string, unknown>)[key];
      if (Array.isArray(value) && value.length) {
        const lines = findTimedLines(value);
        if (lines) return lines;
      }
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      const found = findTimedLines(value);
      if (found) return found;
    }
  }
  return null;
}

function formatLrcTime(timeMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, timeMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hundredths = Math.floor((Math.max(0, timeMs) % 1000) / 10);
  return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}]`;
}

function timedLinesToLrc(rawLines: Record<string, unknown>[]): string | null {
  const lines: { timeMs: number; text: string }[] = [];
  for (const entry of rawLines) {
    const cue =
      typeof entry.cueRange === 'object' && entry.cueRange !== null
        ? (entry.cueRange as Record<string, unknown>)
        : {};
    const start = Number(cue.startTimeMilliseconds ?? NaN);
    if (!Number.isFinite(start) || start < 0) continue;
    const text = String(entry.lyricLine ?? '').trim();
    if (!text) continue;
    lines.push({ timeMs: Math.trunc(start), text });
  }
  lines.sort((a, b) => a.timeMs - b.timeMs);
  if (!lines.length) return null;
  return lines.map((line) => `${formatLrcTime(line.timeMs)}${line.text}`).join('\n');
}

/** Plain lyrics text from a description shelf, if the payload has one. */
export function descriptionShelfText(payload: unknown): string | null {
  const shelf = findNode(payload, (node) =>
    typeof node === 'object' && node !== null && 'musicDescriptionShelfRenderer' in node,
  );
  if (!shelf) return null;
  const renderer = (shelf as Record<string, unknown>).musicDescriptionShelfRenderer as Record<string, unknown>;
  const description = renderer.description as Record<string, unknown> | undefined;
  if (!description) return null;
  const runs = description.runs;
  if (Array.isArray(runs)) {
    const text = runs
      .filter((run): run is Record<string, unknown> => typeof run === 'object' && run !== null)
      .map((run) => String(run.text ?? ''))
      .join('');
    return text.trim() || null;
  }
  const simple = description.simpleText;
  return typeof simple === 'string' && simple.trim() ? simple.trim() : null;
}

function findNode(
  node: unknown,
  predicate: (node: unknown) => boolean,
  depth = 0,
): unknown {
  if (depth > 12) return null;
  if (predicate(node)) return node;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findNode(item, predicate, depth + 1);
      if (found) return found;
    }
  } else if (typeof node === 'object' && node !== null) {
    for (const value of Object.values(node as Record<string, unknown>)) {
      const found = findNode(value, predicate, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// ── YouTube Subtitle ───────────────────────────────────────────────────────

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  name?: string;
}

function captionTracksOf(playerResponse: Record<string, unknown>): CaptionTrack[] {
  const renderer = dig(
    playerResponse,
    ['captions', 'playerCaptionsTracklistRenderer'],
  ) as Record<string, unknown> | undefined;
  const tracks = renderer?.captionTracks;
  if (!Array.isArray(tracks)) return [];
  const result: CaptionTrack[] = [];
  for (const track of tracks) {
    if (typeof track !== 'object' || track === null) continue;
    const record = track as Record<string, unknown>;
    const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl : '';
    if (!baseUrl) continue;
    result.push({
      baseUrl,
      languageCode: String(record.languageCode ?? ''),
      ...(typeof record.kind === 'string' ? { kind: record.kind } : {}),
    });
  }
  return result;
}

function pickCaptionTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  if (!tracks.length) return null;
  const english = tracks.filter((track) => track.languageCode.toLowerCase().startsWith('en'));
  const pool = english.length ? english : tracks;
  return (
    pool.find((track) => !track.kind) ??
    pool.find((track) => track.kind === 'asr') ??
    pool[0]
  );
}

async function fetchCaptionTrack(track: CaptionTrack, signal?: AbortSignal): Promise<CaptionLine[]> {
  const withFormat = (fmt: string): string => {
    const url = new URL(track.baseUrl);
    url.searchParams.set('fmt', fmt);
    return url.toString();
  };
  // The timedtext host answers `Access-Control-Allow-Origin` for the
  // requesting origin (verified by header probe), so direct first;
  // the relay layer is the fallback when the browser cannot read it.
  const attempts: { url: string; viaRelay: boolean }[] = [
    { url: withFormat('json3'), viaRelay: false },
    { url: withFormat('json3'), viaRelay: true },
    { url: withFormat('vtt'), viaRelay: false },
    { url: withFormat('vtt'), viaRelay: true },
  ];
  for (const attempt of attempts) {
    try {
      const { status, text } = attempt.viaRelay
        ? await fetchTextWithRelay(attempt.url, undefined, undefined, signal)
        : await fetchText(attempt.url, undefined, undefined, signal);
      if (status < 200 || status > 299 || !text.trim()) continue;
      const lines = attempt.url.includes('fmt=json3')
        ? parseJson3Captions(parseJsonLenient(text))
        : parseWebVtt(text);
      if (lines.length) return lines;
    } catch {
      // Next attempt (relay, then the other format).
    }
    if (signal?.aborted) break;
  }
  return [];
}

export async function getYoutubeSubtitleLyrics(
  query: YoutubeQuery,
  signal?: AbortSignal,
): Promise<string | null> {
  const { videoId } = cleanQuery(query);
  if (!videoId) return null;
  let html: string | null;
  try {
    html = await fetchWatchPage(videoId, signal);
  } catch {
    // Watch-page transport failure (relays exhausted / rate-limited):
    // rethrow so the chain marks Subtitle failed — "Couldn't reach
    // provider" — rather than labelling it gated.
    throw new Error('YouTube watch page unreachable');
  }
  if (!html) {
    subtitleStatusByVideo.set(videoId, 'gated');
    return null;
  }
  rememberVisitorData(html);
  const playerResponse = extractJsonObject(html, 'ytInitialPlayerResponse');
  if (!playerResponse) {
    subtitleStatusByVideo.set(videoId, 'gated');
    return null;
  }
  const playability = (playerResponse.playabilityStatus ?? {}) as Record<string, unknown>;
  const tracks = captionTracksOf(playerResponse);
  const track = pickCaptionTrack(tracks);
  if (!track) {
    subtitleStatusByVideo.set(
      videoId,
      playability.status === 'OK' ? 'no-captions' : 'gated',
    );
    return null;
  }
  const lines = await fetchCaptionTrack(track, signal);
  if (!lines.length) {
    subtitleStatusByVideo.set(videoId, 'no-captions');
    return null;
  }
  subtitleStatusByVideo.set(videoId, 'ok');
  return captionsToLrc(lines);
}

// ── YouTube Music ──────────────────────────────────────────────────────────

/** Lyrics browse ids (`MPLYt…`) found in a `next` response payload. */
export function findLyricsBrowseIds(payload: unknown, limit = 3): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (found.length >= limit) return;
    if (typeof node === 'object' && node !== null) {
      const record = node as Record<string, unknown>;
      const endpoint = record.browseEndpoint;
      if (typeof endpoint === 'object' && endpoint !== null) {
        const browseId = (endpoint as Record<string, unknown>).browseId;
        if (typeof browseId === 'string' && browseId.startsWith('MPLYt') && !found.includes(browseId)) {
          found.push(browseId);
        }
      }
      const values = Array.isArray(node) ? node : Object.values(record);
      for (const value of values) visit(value);
    }
  };
  visit(payload);
  return found;
}

function browseIdsFromHtml(html: string): string[] {
  const matches = html.match(/MPLYt[A-Za-z0-9_-]+/g) ?? [];
  return [...new Set(matches)].slice(0, 3);
}

async function musicLyricsViaBrowsePost(
  browseId: string,
  visitor: string | null,
  signal?: AbortSignal,
): Promise<string | null> {
  let payload: Record<string, unknown> | null;
  try {
    payload = await postInnertube(
      'music.youtube.com',
      'browse',
      { browseId },
      {
        ...ANDROID_MUSIC_CLIENT,
        ...(visitor ? { visitorData: visitor } : {}),
      },
      signal,
    );
  } catch {
    return null;
  }
  if (!payload) return null;
  const known = dig(payload, TIMED_LYRICS_PATH) as Record<string, unknown> | undefined;
  const rawLines = known?.timedLyricsData;
  if (Array.isArray(rawLines) && rawLines.length) {
    const lrc = timedLinesToLrc(rawLines as Record<string, unknown>[]);
    if (lrc) return lrc;
  }
  const scanned = findTimedLines(payload);
  if (scanned?.length) {
    const lrc = timedLinesToLrc(scanned);
    if (lrc) return lrc;
  }
  return descriptionShelfText(payload);
}

async function musicLyricsViaBrowsePage(
  browseId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  let html: string | null = null;
  try {
    const result = await fetchTextWithRelay(
      `https://music.youtube.com/browse/${browseId}`,
      undefined,
      undefined,
      signal,
    );
    if (result.status >= 200 && result.status <= 299 && result.text.trim()) html = result.text;
  } catch {
    return null;
  }
  if (!html) return null;
  const initialData = extractJsonObject(html, 'ytInitialData');
  if (!initialData) return null;
  return descriptionShelfText(initialData);
}

export async function getYoutubeMusicLyrics(
  query: YoutubeQuery,
  signal?: AbortSignal,
): Promise<string | null> {
  const { videoId } = cleanQuery(query);
  if (!videoId) return null;
  let html: string | null = null;
  let watchPageFailed = false;
  try {
    html = await fetchWatchPage(videoId, signal);
  } catch {
    // Watch-page transport failure: fall through to the `next`
    // POST below, which is an independent resolution path.
    html = null;
    watchPageFailed = true;
  }
  let browseIds: string[] = [];
  if (html) {
    rememberVisitorData(html);
    const initialData = extractJsonObject(html, 'ytInitialData');
    if (initialData) browseIds = findLyricsBrowseIds(initialData);
    if (!browseIds.length) browseIds = browseIdsFromHtml(html);
  }
  if (!browseIds.length) {
    // No browse id from the watch page: the direct `next` POST is
    // the only remaining resolution path. It needs the same CORS
    // luck as the browse POST below, so it is attempted, not assumed.
    try {
      const visitor = loadVisitorData();
      const next = await postInnertube(
        'www.youtube.com',
        'next',
        { videoId },
        { ...WEB_CLIENT, ...(visitor ? { visitorData: visitor } : {}) },
        signal,
      );
      if (next) browseIds = findLyricsBrowseIds(next);
    } catch {
      // Both the watch page and the `next` POST failed: the
      // provider is unreachable, not empty.
      if (watchPageFailed) throw new Error('YouTube Music unreachable');
      return null;
    }
  }
  const visitor = loadVisitorData();
  for (const browseId of browseIds) {
    const viaPost = await musicLyricsViaBrowsePost(browseId, visitor, signal);
    if (viaPost?.trim()) return viaPost;
    if (signal?.aborted) return null;
    const viaPage = await musicLyricsViaBrowsePage(browseId, signal);
    if (viaPage?.trim()) return viaPage;
    if (signal?.aborted) return null;
  }
  return null;
}
