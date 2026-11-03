/**
 * YouTube providers, running entirely in the browser.
 *
 * Both providers read the same public web surfaces a browser tab
 * itself uses — no API server, no credentials, no PoToken minting.
 * The request shapes below mirror the Android app's InnerTube
 * client exactly (`android/core/.../innertube/`): WEB_REMIX
 * (`clientVersion 1.20260707.12.00`, client id 67) for `next`,
 * `browse` and `get_transcript`, and the bare ANDROID_MUSIC
 * browse (client only, no visitor data — the exact shape of
 * `server/core.py::_browse_mobile`) for timed lyrics lines.
 *
 * Resolution order for YouTube Music (the watch-page HTML YouTube
 * serves to relay/datacenter IPs is a JS shell with NO embedded
 * `ytInitialPlayerResponse`/`ytInitialData` — verified live
 * 2026-11-03: a 610KB AllOrigins body with zero occurrences of
 * either marker — so the HTML scan alone cannot resolve the
 * lyrics browse id):
 * 1. Innertube `next` POST (WEB_REMIX) → lyrics tab endpoint.
 * 2. Watch-page HTML scan (direct, then relay) for MPLYt ids.
 * 3. `watch?v=…&pbj=1` JSON (GET, relay-readable) — the same
 *    Innertube payloads as JSON instead of embedded HTML.
 * 4. Browse-page HTML GET fallback (plain lyrics only).
 * Every step is tried; a provider that reached YouTube but found
 * no lyrics tab returns null ("No lyrics found"), while a provider
 * whose every transport failed throws ("Couldn't reach provider").
 *
 * Subtitle order:
 * 1. Innertube `get_transcript` POST (WEB_REMIX, params =
 *    base64("\\n\\x0b" + videoId), exactly as Android builds it)
 *    — attempted WITHOUT a PoToken; when YouTube requires one the
 *    endpoint answers empty and the fallbacks below run.
 * 2. Watch-page player response → caption tracks → timedtext.
 * 3. `pbj=1` player response → same caption-track path.
 * A page that loads but lists no caption tracks is "No captions
 * for this video". A page that carries NO player data at all (the
 * JS shell) is NOT "gated": it is unresolved, and the picker says
 * so with the failure label. "Not available on web" appears only
 * when a player response exists whose playability status is not
 * OK (a genuine login/PoToken wall).
 *
 * Innertube POSTs are plain `fetch` POSTs: whether a foreign
 * origin may *read* the response is decided by YouTube's
 * `Access-Control-Allow-Origin` header, which cannot be verified
 * from the sandbox (its egress IP is 403-blocked by Google and
 * its headless browser cannot complete TLS to YouTube). The code
 * tries the direct POST first and falls through to the GET paths
 * when the browser blocks it — on a real phone the direct path
 * is what decides whether timed YouTube Music lyrics and
 * transcripts appear. This is reported honestly as unverified,
 * never claimed as proven.
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
 * The subtitle provider therefore attempts `get_transcript`
 * without one, then the unauthenticated player-response path;
 * when a player response exists and reports the video as gated
 * (login/PoToken required), the row is labelled "Not available
 * on web" instead of pretending there are no captions. When the
 * player loads fine but lists no caption tracks, the label is
 * "No captions for this video". A shell page with no player data
 * at all is neither: it is unresolved.
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
/** WEB_REMIX client, exactly as Android's InnerTube profile (client id 67). */
export const WEB_REMIX_CLIENT = { clientName: 'WEB_REMIX', clientVersion: '1.20260707.12.00' };
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

export type SubtitleStatus = 'no-captions' | 'gated' | 'ok' | 'unresolved';

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

/** WEB_REMIX context exactly as Android's `YouTubeClient.toContext`. */
export function webRemixContext(visitor: string | null): Record<string, unknown> {
  return {
    client: {
      ...WEB_REMIX_CLIENT,
      gl: 'US',
      hl: 'en',
      ...(visitor ? { visitorData: visitor } : {}),
    },
    user: {},
  };
}

/** Bare ANDROID_MUSIC context — the exact shape of `_browse_mobile`. */
function androidMusicContext(): Record<string, unknown> {
  return { client: { ...ANDROID_MUSIC_CLIENT } };
}

/**
 * `get_transcript` params, exactly as Android builds them:
 * base64 of `"\n" + chr(11) + videoId` (standard alphabet, padded).
 */
export function transcriptParams(videoId: string): string {
  return btoa(`\n\x0b${videoId}`);
}

/** Cue groups from a `get_transcript` response, or `null` when absent. */
export function transcriptCues(payload: unknown): CaptionLine[] | null {
  const actions = (payload as Record<string, unknown> | null)?.actions;
  if (!Array.isArray(actions) || !actions.length) return null;
  const renderer = dig(actions[0], [
    'updateEngagementPanelAction',
    'content',
    'transcriptRenderer',
    'body',
    'transcriptBodyRenderer',
  ]) as Record<string, unknown> | undefined;
  const cueGroups = renderer?.cueGroups;
  if (!Array.isArray(cueGroups)) return null;
  const lines: CaptionLine[] = [];
  for (const group of cueGroups) {
    const groupRenderer = dig(group, ['transcriptCueGroupRenderer']) as
      | Record<string, unknown>
      | undefined;
    const cues = groupRenderer?.cues;
    if (!Array.isArray(cues) || !cues.length) continue;
    const cue = dig(cues[0], ['transcriptCueRenderer']) as Record<string, unknown> | undefined;
    if (!cue) continue;
    const startMs = Number(cue.startOffsetMs ?? NaN);
    if (!Number.isFinite(startMs)) continue;
    const cueText = (cue.cue as Record<string, unknown> | undefined)?.simpleText;
    const text = typeof cueText === 'string' ? cueText.replace(/^♪+|♪+$/g, '').trim() : '';
    if (!text) continue;
    lines.push({ timeMs: Math.max(0, Math.trunc(startMs)), text });
  }
  return lines.length ? lines : null;
}

/** Deep-scan any JSON node for a player response and MPLYt browse ids. */
export function scanPayloadForYoutubeData(
  node: unknown,
): { playerResponse: Record<string, unknown> | null; browseIds: string[] } {
  let playerResponse: Record<string, unknown> | null = null;
  const browseIds: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (!playerResponse) {
      const candidate = record.playerResponse;
      if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
        playerResponse = candidate as Record<string, unknown>;
      } else if (
        'playabilityStatus' in record &&
        'captions' in record &&
        typeof record.playabilityStatus === 'object'
      ) {
        playerResponse = record;
      }
    }
    const endpoint = record.browseEndpoint;
    if (typeof endpoint === 'object' && endpoint !== null) {
      const browseId = (endpoint as Record<string, unknown>).browseId;
      if (typeof browseId === 'string' && browseId.startsWith('MPLYt') && !browseIds.includes(browseId)) {
        browseIds.push(browseId);
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(node);
  return { playerResponse, browseIds };
}

/**
 * `watch?v=…&pbj=1` via the relay layer: the watch payloads as JSON
 * (GET, so relay-readable) instead of embedded in HTML. Returns the
 * scanned player response / browse ids, or `null` when the response
 * is HTML (a shell page) or unparseable.
 */
async function fetchPbjWatchData(
  videoId: string,
  signal?: AbortSignal,
): Promise<{ playerResponse: Record<string, unknown> | null; browseIds: string[] } | null> {
  let result;
  try {
    result = await fetchTextWithRelay(
      'https://www.youtube.com/watch',
      { v: videoId, pbj: 1 },
      undefined,
      signal,
    );
  } catch {
    return null;
  }
  if (result.status < 200 || result.status > 299) return null;
  const trimmed = result.text.trimStart();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return null;
  const parsed = parseJsonLenient(result.text);
  if (parsed == null) return null;
  return scanPayloadForYoutubeData(parsed);
}

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
  // Callers may supply extra context fields (gl/hl/user and
  // client fields, as Android's toContext does); the client
  // name/version always come from the `client` argument.
  const suppliedContext =
    typeof body.context === 'object' && body.context !== null && !Array.isArray(body.context)
      ? (body.context as Record<string, unknown>)
      : {};
  const suppliedClient =
    typeof suppliedContext.client === 'object' &&
    suppliedContext.client !== null &&
    !Array.isArray(suppliedContext.client)
      ? (suppliedContext.client as Record<string, unknown>)
      : {};
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...body,
      context: { ...suppliedContext, client: { ...suppliedClient, ...client } },
    }),
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

/** Caption-track LRC from one player response, or `null` when it has no usable track. */
async function lyricsFromPlayerResponse(
  playerResponse: Record<string, unknown>,
  videoId: string,
  signal?: AbortSignal,
): Promise<string | null> {
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

/**
 * `get_transcript` without a PoToken (Android's route minus the
 * BotGuard token). Returns LRC, `null` when YouTube answers but
 * has no transcript, and throws on transport/CORS failure.
 */
async function subtitleLyricsViaTranscript(
  videoId: string,
  visitor: string | null,
  signal?: AbortSignal,
): Promise<string | null> {
  const payload = await postInnertube(
    'music.youtube.com',
    'get_transcript',
    {
      params: transcriptParams(videoId),
      context: webRemixContext(visitor),
    },
    { ...WEB_REMIX_CLIENT, ...(visitor ? { visitorData: visitor } : {}) },
    signal,
  );
  if (!payload) return null;
  const cues = transcriptCues(payload);
  if (!cues) return null;
  subtitleStatusByVideo.set(videoId, 'ok');
  return captionsToLrc(cues);
}

export async function getYoutubeSubtitleLyrics(
  query: YoutubeQuery,
  signal?: AbortSignal,
): Promise<string | null> {
  const { videoId } = cleanQuery(query);
  if (!videoId) return null;
  const visitor = loadVisitorData();
  // 1. Transcript endpoint (no PoToken). A transport/CORS failure
  //    is remembered, not fatal: the watch-page routes below run.
  let transcriptFailed = false;
  try {
    const viaTranscript = await subtitleLyricsViaTranscript(videoId, visitor, signal);
    if (viaTranscript) return viaTranscript;
  } catch {
    transcriptFailed = true;
  }
  if (signal?.aborted) return null;
  // 2. Watch-page player response → caption tracks → timedtext.
  let html: string | null;
  try {
    html = await fetchWatchPage(videoId, signal);
  } catch {
    // Watch-page transport failure (relays exhausted / rate-limited):
    // rethrow so the chain marks Subtitle failed — "Couldn't reach
    // provider" — rather than labelling it gated.
    throw new Error('YouTube watch page unreachable');
  }
  if (html) {
    rememberVisitorData(html);
    const playerResponse = extractJsonObject(html, 'ytInitialPlayerResponse');
    if (playerResponse) {
      const result = await lyricsFromPlayerResponse(playerResponse, videoId, signal);
      if (result) return result;
      // A player response with no usable track is a real answer:
      // keep its status (no-captions / gated), do not fall through
      // to the pbj scan and overwrite it with "unresolved".
      return null;
    }
  }
  // 3. pbj=1 JSON payloads carry the same player response when
  //    the HTML shell does not embed it.
  const pbj = await fetchPbjWatchData(videoId, signal);
  if (pbj?.playerResponse) {
    const result = await lyricsFromPlayerResponse(pbj.playerResponse, videoId, signal);
    if (result) return result;
    return null;
  }
  // No player data anywhere: the shell page is unresolved, NOT
  // gated — unless the transcript attempt also failed, in which
  // case every route failed and the chain marks it failed.
  if (transcriptFailed && !html) {
    throw new Error('YouTube watch page unreachable');
  }
  subtitleStatusByVideo.set(videoId, 'unresolved');
  return null;
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

/** A lyrics browse endpoint: browse id + the endpoint's params (Android passes both to `browse`). */
export interface LyricsEndpoint {
  browseId: string;
  params?: string;
}

/**
 * The lyrics tab endpoint from a `next` response, preferring the
 * tabbed-renderer's second tab exactly as Android's `YouTube.next`
 * does (tabs[1] is Lyrics, tabs[2] Related), falling back to any
 * MPLYt browse endpoint in the payload.
 */
export function findLyricsEndpoint(payload: unknown): LyricsEndpoint | null {
  const tabs = dig(payload, [
    'contents',
    'singleColumnMusicWatchNextResultsRenderer',
    'tabbedRenderer',
    'watchNextTabbedResultsRenderer',
    'tabs',
  ]);
  if (Array.isArray(tabs) && tabs.length > 1) {
    const endpoint = dig(tabs[1], ['tabRenderer', 'endpoint', 'browseEndpoint']) as
      | Record<string, unknown>
      | undefined;
    const browseId = endpoint?.browseId;
    if (typeof browseId === 'string' && browseId.startsWith('MPLYt')) {
      const params = endpoint?.params;
      return {
        browseId,
        ...(typeof params === 'string' && params ? { params } : {}),
      };
    }
  }
  const ids = findLyricsBrowseIds(payload);
  return ids.length ? { browseId: ids[0] } : null;
}

async function browsePost(
  host: string,
  endpoint: LyricsEndpoint,
  client: InnertubeClient,
  context: Record<string, unknown> | undefined,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  try {
    return await postInnertube(
      host,
      'browse',
      {
        browseId: endpoint.browseId,
        ...(endpoint.params ? { params: endpoint.params } : {}),
        ...(context ? { context } : {}),
      },
      client,
      signal,
    );
  } catch {
    return null;
  }
}

async function musicLyricsViaBrowsePost(
  endpoint: LyricsEndpoint,
  visitor: string | null,
  signal?: AbortSignal,
): Promise<string | null> {
  // 1. WEB_REMIX browse (Android's `lyrics()`): plain text from
  //    the description shelf.
  const remixPayload = await browsePost(
    'music.youtube.com',
    endpoint,
    { ...WEB_REMIX_CLIENT, ...(visitor ? { visitorData: visitor } : {}) },
    webRemixContext(visitor),
    signal,
  );
  if (remixPayload) {
    const shelf = descriptionShelfText(remixPayload);
    if (shelf) return shelf;
  }
  if (signal?.aborted) return null;
  // 2. Bare ANDROID_MUSIC browse (the `_browse_mobile` shape):
  //    timed lines first, description shelf as fallback.
  const payload = await browsePost(
    'music.youtube.com',
    endpoint,
    { ...ANDROID_MUSIC_CLIENT },
    androidMusicContext(),
    signal,
  );
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
  const endpoints: LyricsEndpoint[] = [];
  const addEndpoint = (endpoint: LyricsEndpoint | null) => {
    if (endpoint && !endpoints.some((e) => e.browseId === endpoint.browseId)) {
      endpoints.push(endpoint);
    }
  };
  const addIds = (ids: string[]) => {
    for (const browseId of ids) addEndpoint({ browseId });
  };
  // `reached` = some YouTube surface actually answered (a POST
  // returned a payload, or a page/JSON body arrived). When true
  // and no lyrics were found, the video genuinely has no lyrics
  // tab here: return null. When nothing answered at all, throw so
  // the chain marks the provider failed.
  let reached = false;
  const tried = new Set<string>();

  // 1. Innertube `next` POST (WEB_REMIX, Android's exact path):
  //    the lyrics tab endpoint, params included.
  try {
    const visitor = loadVisitorData();
    const next = await postInnertube(
      'music.youtube.com',
      'next',
      { videoId, context: webRemixContext(visitor) },
      { ...WEB_REMIX_CLIENT, ...(visitor ? { visitorData: visitor } : {}) },
      signal,
    );
    if (next) {
      reached = true;
      addEndpoint(findLyricsEndpoint(next));
      addIds(findLyricsBrowseIds(next));
    }
  } catch {
    // Fall through to the GET resolution paths.
  }
  if (signal?.aborted) return null;

  const tryEndpoints = async (): Promise<string | null> => {
    const visitor = loadVisitorData();
    for (const endpoint of endpoints) {
      if (tried.has(endpoint.browseId)) continue;
      tried.add(endpoint.browseId);
      const viaPost = await musicLyricsViaBrowsePost(endpoint, visitor, signal);
      if (viaPost?.trim()) return viaPost;
      if (signal?.aborted) return null;
      const viaPage = await musicLyricsViaBrowsePage(endpoint.browseId, signal);
      if (viaPage?.trim()) return viaPage;
      if (signal?.aborted) return null;
    }
    return null;
  };
  const viaNext = await tryEndpoints();
  if (viaNext) return viaNext;
  if (signal?.aborted) return null;

  // 2. Watch-page HTML scan for MPLYt ids (the embedded
  //    `ytInitialData` shape; absent from the JS shell page).
  let html: string | null = null;
  try {
    html = await fetchWatchPage(videoId, signal);
  } catch {
    html = null;
  }
  if (html) {
    reached = true;
    rememberVisitorData(html);
    const initialData = extractJsonObject(html, 'ytInitialData');
    if (initialData) addIds(findLyricsBrowseIds(initialData));
    if (!endpoints.length) addIds(browseIdsFromHtml(html));
    const viaWatch = await tryEndpoints();
    if (viaWatch) return viaWatch;
    if (signal?.aborted) return null;
  }

  // 3. pbj=1 JSON payloads (GET, relay-readable).
  const pbj = await fetchPbjWatchData(videoId, signal);
  if (pbj) {
    reached = true;
    addIds(pbj.browseIds);
    const viaPbj = await tryEndpoints();
    if (viaPbj) return viaPbj;
    if (signal?.aborted) return null;
  }

  if (!reached) throw new Error('YouTube Music unreachable');
  return null;
}
