/**
 * Client-side lyrics providers — every provider runs directly in the
 * browser with `fetch`. There is no server fallback: the picker, the
 * pin flow and the lyrics panel all run this chain and nothing else.
 *
 * Providers whose hosts send no CORS headers for this origin cannot
 * be read cross-origin (BetterLyrics/Portato, KuGou, Megalobiz,
 * SimpMusic); a public CORS relay (cors.dev first, then AllOrigins
 * — see `http.ts`) is tried for those origins before the provider
 * is reported empty. Paxsenix never goes through a relay.
 *
 * YouTube Music and YouTube Subtitle run in the browser too (see
 * `youtube.ts`): the watch page (GET, via the relay layer) plus
 * Innertube POSTs with the public WEB client. Whether YouTube
 * answers a foreign origin's POST readably is decided by its CORS
 * headers and cannot be proven from the sandbox — the GET fallbacks
 * (caption timedtext, browse-page lyrics) are what carry those two
 * providers when the POST path is blocked.
 *
 * Headers follow the browser limits: `User-Agent` is never set (a
 * forbidden fetch header, silently ignored) and `Content-Type` is
 * never sent on GETs. `Authorization: Bearer <key>` is sent to
 * Paxsenix only, with the key trimmed, and only when a non-blank key
 * is supplied — Paxsenix providers issue no request at all without one.
 */
import { LYRICS_CHAIN, LYRICS_CHAIN_IDS } from '../types/models';
import {
  decodeBase64Utf8,
  fetchJsonWithRelay,
  fetchText,
  fetchTextWithRelay,
  parseJsonLenient,
  throwIfUpstreamFailure,
  type FetchParams,
} from './http';
import { isLineSyncedLrc } from './parse';
import { isQrc } from './qrc';
import {
  getSubtitleStatus,
  getYoutubeMusicLyrics,
  getYoutubeSubtitleLyrics,
  type YoutubeQuery,
} from './youtube';

export interface ProviderContext {
  videoId: string;
  title: string;
  artist: string;
  album: string;
  /** Duration in seconds, or `null` when unknown. */
  durationSeconds: number | null;
  /** Paxsenix API key, trimmed or `undefined`. Never logged. */
  paxsenixKey?: string;
}

export type ProviderFetch = (
  ctx: ProviderContext,
  signal?: AbortSignal,
) => Promise<string | null>;
export type ProviderFetchAll = (
  ctx: ProviderContext,
  signal?: AbortSignal,
) => Promise<string[]>;

export interface ProviderDefinition {
  id: string;
  name: string;
  requiresKey: boolean;
  alwaysUnavailable: boolean;
  /**
   * Reason label for an empty result, when the provider can tell the
   * difference between "nothing held" and "cannot run here" (YouTube
   * Subtitle: no captions vs gated). `null` = the generic label.
   */
  describeEmpty?: (ctx: ProviderContext) => string | null;
  /**
   * Reason label for a FAILED result (transport/upstream failure),
   * when the provider knows the failure is a permanent gate rather
   * than a transient outage (SimpMusic: User-Agent gate). `null` =
   * the generic "Couldn't reach provider" label.
   */
  describeFailed?: (ctx: ProviderContext) => string | null;
  getLyrics: ProviderFetch;
  getAllLyrics: ProviderFetchAll;
}

function cleanCtx(ctx: ProviderContext): ProviderContext {
  return {
    videoId: ctx.videoId ?? '',
    title: (ctx.title ?? '').trim(),
    artist: (ctx.artist ?? '').trim(),
    album: (ctx.album ?? '').trim(),
    durationSeconds: ctx.durationSeconds ?? null,
    paxsenixKey: ctx.paxsenixKey?.trim() || undefined,
  };
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function usable(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

// ── BetterLyrics / Portato ─────────────────────────────────────────────────

const BETTERLYRICS_BASE = 'https://lyrics-api.boidu.dev/';
const TTML_ROOT_RE = /^<(?:[A-Za-z_][\w.-]*:)?tt(?:\s|>)/i;
const XML_DECL_RE = /^\s*<\?xml[^>]*\?>\s*/i;
const MAX_TTML_ROOT_SCAN_LENGTH = 4096;
const MAX_RESPONSE_UNWRAP_DEPTH = 2;

/**
 * Whether *value* is itself a TTML document (not an envelope holding
 * one). The check is anchored at the document start — after an
 * optional XML declaration — because an unanchored search matches
 * the `<tt>` inside a JSON envelope's TTML string and misclassifies
 * the whole envelope as raw TTML, so the unwrap branch below could
 * never fire. (The server port's unanchored search has that latent
 * defect; anchoring is the intended envelope behaviour.)
 */
function isTtmlPayload(value: string): boolean {
  const scanned = value.slice(0, MAX_TTML_ROOT_SCAN_LENGTH);
  const stripped = scanned.replace(XML_DECL_RE, '').trimStart();
  return TTML_ROOT_RE.test(stripped);
}

/**
 * Whether *value* is itself a QRC document (not a JSON envelope).
 * The `qq/getLyrics` (Portato) endpoint returns QRC inside the
 * `lyrics` envelope key; QRC is a first-class lyric format for the
 * chain parser (`qrc.ts`), so a QRC payload is valid content exactly
 * like a TTML one. The raw-envelope check is gated on the text
 * starting with `<`: a JSON envelope merely *contains* the QRC
 * markers inside its escaped string, and must still go through the
 * unwrap branch so the parser receives the QRC text itself.
 */
function isQrcPayload(value: string): boolean {
  return value.trimStart().startsWith('<') && isQrc(value);
}

function decodeLyrics(responseText: string): { content: string; score: number | null } | null {
  const raw = responseText.startsWith('﻿') ? responseText.slice(1) : responseText;
  if (isTtmlPayload(raw)) return { content: raw, score: null };
  if (isQrcPayload(raw)) return { content: raw, score: null };
  const root = parseJsonLenient(responseText);
  if (root == null) return null;
  let score: number | null = null;
  if (typeof root === 'object' && !Array.isArray(root)) {
    const dict = root as Record<string, unknown>;
    const ttmlValue = dict.ttml ?? dict.lyrics ?? '';
    if (typeof ttmlValue === 'string' && (isTtmlPayload(ttmlValue) || isQrc(ttmlValue))) {
      const s = dict.score;
      score = typeof s === 'number' ? s : null;
      return { content: ttmlValue, score };
    }
  }
  const nested = decodeElement(root, 0);
  if (!nested) return null;
  return { content: nested.content, score: score ?? nested.score };
}

function decodeElement(
  element: unknown,
  depth: number,
): { content: string; score: number | null } | null {
  if (depth > MAX_RESPONSE_UNWRAP_DEPTH) return null;
  if (typeof element === 'object' && element !== null && !Array.isArray(element)) {
    const dict = element as Record<string, unknown>;
    const s = dict.score;
    const score = typeof s === 'number' ? s : null;
    let payload: unknown;
    let found = false;
    for (const key of ['ttml', 'lyrics', 'data', 'result', 'response']) {
      if (key in dict) {
        payload = dict[key];
        found = true;
        break;
      }
    }
    if (!found) return null;
    const decoded = decodeElement(payload, depth + 1);
    if (!decoded) return null;
    return { content: decoded.content, score: score ?? decoded.score };
  }
  if (typeof element === 'string') {
    if (isTtmlPayload(element) || isQrc(element)) return { content: element, score: null };
    if (depth < MAX_RESPONSE_UNWRAP_DEPTH) {
      const nested = parseJsonLenient(element);
      if (nested == null) return null;
      return decodeElement(nested, depth + 1);
    }
    return null;
  }
  return null;
}

async function fetchBetterLyricsEndpoint(
  endpoint: string,
  title: string,
  artist: string,
  album: string,
  durationSeconds: number | null,
  signal?: AbortSignal,
): Promise<string | null> {
  const params: FetchParams = { s: title, a: artist };
  if (album) params.al = album;
  if (durationSeconds != null && durationSeconds > 0) params.d = durationSeconds;
  const result = await fetchTextWithRelay(BETTERLYRICS_BASE + endpoint, params, undefined, signal);
  // 401/403/429/5xx is an upstream failure (e.g. BetterLyrics now
  // gates uncached queries behind an API key), not "no lyrics":
  // throw so the chain marks the provider failed.
  throwIfUpstreamFailure(result);
  if (result.status < 200 || result.status > 299) return null;
  const decoded = decodeLyrics(result.text);
  if (!decoded) return null;
  return decoded.content.trim() ? decoded.content : null;
}

async function fetchBetterLyrics(
  ctx: ProviderContext,
  endpoints: string[],
  signal?: AbortSignal,
): Promise<string | null> {
  const { title, artist, album, durationSeconds } = cleanCtx(ctx);
  if (!title || !artist) return null;
  let lastError: unknown = null;
  for (const endpoint of endpoints) {
    try {
      const lyrics = await fetchBetterLyricsEndpoint(endpoint, title, artist, album, durationSeconds, signal);
      if (lyrics) return lyrics;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

const betterLyricsGet: ProviderFetch = (ctx, signal) =>
  fetchBetterLyrics(ctx, ['getLyrics', 'kugou/getLyrics'], signal);
const portatoGet: ProviderFetch = (ctx, signal) =>
  fetchBetterLyrics(ctx, ['qq/getLyrics'], signal);

async function singleAsAll(fetch: ProviderFetch): Promise<ProviderFetchAll> {
  return async (ctx, signal) => {
    const result = await fetch(ctx, signal);
    return result ? [result] : [];
  };
}

// ── YouLyPlus ──────────────────────────────────────────────────────────────

// Mirrors verified live 2026-11-02: binimum answers v2 with real
// data direct and via relay; prjktla.my.id answers v2 via relay.
// The v1 TTML endpoint 404s on binimum now, so v2 is tried FIRST
// across mirrors and v1 only as a fallback — sweeping v1 across
// five mirrors first burned the whole provider budget before v2
// was ever reached. The other three mirrors are dead (workers.dev
// 1042, atomix.one invalid TLS, vercel 402 deployment disabled).
const YOULYPLUS_BASES = [
  'https://lyricsplus.binimum.org/',
  'https://lyricsplus.prjktla.my.id/',
];

function formatLrcTimestamp(timeMs: number, bracketed: boolean): string {
  const safeMs = Math.max(0, Math.trunc(timeMs));
  const minutes = Math.floor(safeMs / 60000);
  const seconds = Math.floor((safeMs % 60000) / 1000);
  const millis = safeMs % 1000;
  const timestamp = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  return bracketed ? `[${timestamp}]` : `<${timestamp}>`;
}

function youLyPlusToText(response: Record<string, unknown>): string | null {
  const lyrics = (response.lyrics ?? []) as unknown[];
  if (!lyrics.length) return null;
  const timed = lyrics.filter(
    (line): line is Record<string, unknown> =>
      typeof line === 'object' && line !== null && (line as Record<string, unknown>).time != null,
  );
  if (timed.length) {
    const outLines: string[] = [];
    for (const line of timed) {
      const parts: string[] = [formatLrcTimestamp(Number(line.time), true)];
      const syllables = ((line.syllabus ?? []) as unknown[]).filter(
        (s): s is Record<string, unknown> =>
          typeof s === 'object' && s !== null && Boolean((s as Record<string, unknown>).text) && (s as Record<string, unknown>).time != null,
      );
      if (String(response.type ?? '').toLowerCase() === 'word' && syllables.length) {
        for (const syllable of syllables) {
          parts.push(formatLrcTimestamp(Number(syllable.time), false));
          parts.push(String(syllable.text ?? ''));
        }
      } else {
        parts.push(String(line.text ?? ''));
      }
      outLines.push(parts.join(''));
    }
    const text = outLines.join('\n');
    return text.trim() ? text : null;
  }
  const text = lyrics
    .filter((line): line is Record<string, unknown> => typeof line === 'object' && line !== null)
    .map((line) => String(line.text ?? '').trim())
    .filter(Boolean)
    .join('\n');
  return text || null;
}

async function fetchYouLyPlusFromMirrors(
  path: string,
  title: string,
  artist: string,
  album: string,
  durationSeconds: number | null,
  decode: (body: string) => string | null,
  signal?: AbortSignal,
): Promise<string | null> {
  const params: FetchParams = { title, artist };
  if (album) params.album = album;
  if (durationSeconds != null && durationSeconds > 0) params.duration = durationSeconds;
  let lastError: unknown = null;
  for (const baseUrl of YOULYPLUS_BASES) {
    try {
      const result = await fetchTextWithRelay(baseUrl + path, params, { Accept: 'application/json' }, signal);
      throwIfUpstreamFailure(result);
      if (result.status < 200 || result.status > 299) continue;
      const lyrics = decode(result.text);
      if (lyrics && lyrics.trim()) return lyrics;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

const youLyPlusGet: ProviderFetch = async (ctx, signal) => {
  const { title, artist, album, durationSeconds } = cleanCtx(ctx);
  if (!title || !artist) return null;
  // v2 FIRST: the v1 TTML endpoint 404s on the live mirrors, and
  // sweeping it across mirrors burned the budget before v2 ran.
  let v2Error: unknown = null;
  try {
    const v2 = await fetchYouLyPlusFromMirrors(
      'v2/lyrics/get',
      title,
      artist,
      album,
      durationSeconds,
      (body) => {
        const parsed = parseJsonLenient(body);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
        return youLyPlusToText(parsed as Record<string, unknown>);
      },
      signal,
    );
    if (v2) return v2;
  } catch (error) {
    // Fall through to v1: a v2 transport failure must not hide a
    // working v1 mirror. If v1 also yields nothing, the v2 failure
    // is rethrown below so the chain marks the provider failed
    // instead of empty.
    v2Error = error;
  }
  const v1 = await fetchYouLyPlusFromMirrors(
    'v1/ttml/get',
    title,
    artist,
    album,
    durationSeconds,
    (body) => {
      const trimmed = body.trim();
      let candidate: string | null = null;
      if (trimmed.startsWith('<')) candidate = trimmed;
      else {
        const parsed = parseJsonLenient(body);
        candidate =
          typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? String((parsed as Record<string, unknown>).ttml ?? '').trim() || null
            : null;
      }
      return candidate && candidate.startsWith('<') ? candidate : null;
    },
    signal,
  );
  if (!v1 && v2Error) throw v2Error;
  return v1;
};

// ── LrcLib ─────────────────────────────────────────────────────────────────

const LRCLIB_SEARCH_URL = 'https://lrclib.net/api/search';
const LRCLIB_MAX_RESULTS = 5;
const LRCLIB_MAX_DURATION_DELTA = 2;

interface LrcLibTrack {
  trackName: string;
  artistName: string;
  duration: number;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

function levenshtein(s1: string, s2: string): number {
  const len1 = s1.length;
  const len2 = s2.length;
  const matrix: number[][] = Array.from({ length: len1 + 1 }, () => new Array<number>(len2 + 1).fill(0));
  for (let i = 0; i <= len1; i++) matrix[i][0] = i;
  for (let j = 0; j <= len2; j++) matrix[0][j] = j;
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[len1][len2];
}

function similarity(str1: string, str2: string): number {
  const s1 = str1.trim().toLowerCase();
  const s2 = str2.trim().toLowerCase();
  if (s1 === s2) return 1;
  if (!s1 || !s2) return 0;
  const containsScore = s1.includes(s2) || s2.includes(s1) ? 0.8 : 0;
  const maxLength = Math.max(s1.length, s2.length);
  return Math.max(containsScore, 1 - levenshtein(s1, s2) / maxLength);
}

function lrclibSimilarity(str1: string, str2: string): number {
  const s1 = str1.trim().toLowerCase();
  const s2 = str2.trim().toLowerCase();
  if (s1 === s2) return 1;
  if (!s1 || !s2) return 0;
  if (s1.includes(s2) || s2.includes(s1)) return 0.8;
  return 1 - levenshtein(s1, s2) / Math.max(s1.length, s2.length);
}

async function queryLrcLib(
  title: string,
  artist: string,
  album: string,
  signal?: AbortSignal,
): Promise<LrcLibTrack[]> {
  const params: FetchParams = { track_name: title, artist_name: artist };
  if (album) params.album_name = album;
  const payload = await fetchJsonWithRelay(LRCLIB_SEARCH_URL, params, undefined, signal);
  if (!Array.isArray(payload)) return [];
  const tracks: LrcLibTrack[] = [];
  for (const item of payload) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const track: LrcLibTrack = {
      trackName: String(record.trackName ?? ''),
      artistName: String(record.artistName ?? ''),
      duration: Number(record.duration ?? 0) || 0,
      plainLyrics: typeof record.plainLyrics === 'string' ? record.plainLyrics : null,
      syncedLyrics: typeof record.syncedLyrics === 'string' ? record.syncedLyrics : null,
    };
    if (usable(track.syncedLyrics) || usable(track.plainLyrics)) tracks.push(track);
  }
  return tracks;
}

function findBestMatch(tracks: LrcLibTrack[], title: string, artist: string): LrcLibTrack | null {
  let best: LrcLibTrack | null = null;
  let bestScore: number | null = null;
  for (const track of tracks) {
    let score = (similarity(title, track.trackName) + similarity(artist, track.artistName)) / 2;
    if (track.syncedLyrics != null) score += 0.1;
    if (bestScore == null || score > bestScore) {
      best = track;
      bestScore = score;
    }
  }
  if (!best) return null;
  const average = (similarity(title, best.trackName) + similarity(artist, best.artistName)) / 2;
  return average > 0.6 ? best : null;
}

function bestMatchingFor(tracks: LrcLibTrack[], duration: number, title?: string, artist?: string): LrcLibTrack | null {
  if (!tracks.length) return null;
  if (duration === -1) {
    if (title != null && artist != null) return findBestMatch(tracks, title, artist);
    return tracks.find((t) => t.syncedLyrics != null) ?? tracks[0];
  }
  const best = tracks.reduce((a, b) =>
    Math.abs(b.duration - duration) < Math.abs(a.duration - duration) ? b : a,
  );
  return Math.abs(best.duration - duration) <= 2 ? best : null;
}

function preferredLyrics(track: LrcLibTrack): string | null {
  if (usable(track.syncedLyrics)) return track.syncedLyrics;
  if (usable(track.plainLyrics)) return track.plainLyrics;
  return null;
}

const lrclibGet: ProviderFetch = async (ctx, signal) => {
  const { title, artist, album, durationSeconds } = cleanCtx(ctx);
  const duration = durationSeconds == null ? -1 : Math.trunc(durationSeconds);
  const tracks = await queryLrcLib(title, artist, album, signal);
  const track =
    duration === -1 ? bestMatchingFor(tracks, duration, title, artist) : bestMatchingFor(tracks, duration);
  return track ? preferredLyrics(track) : null;
};

const lrclibGetAll: ProviderFetchAll = async (ctx, signal) => {
  const { title, artist, album, durationSeconds } = cleanCtx(ctx);
  const duration = durationSeconds == null ? -1 : Math.trunc(durationSeconds);
  const tracks = await queryLrcLib(title, artist, album, signal);
  let sorted: LrcLibTrack[];
  if (duration === -1) {
    sorted = [...tracks].sort((a, b) => {
      const scoreOf = (t: LrcLibTrack) =>
        (usable(t.syncedLyrics) ? 1 : 0) +
        (usable(t.plainLyrics) ? 0.25 : 0) +
        (lrclibSimilarity(title, t.trackName) + lrclibSimilarity(artist, t.artistName)) / 2;
      return scoreOf(b) - scoreOf(a);
    });
  } else {
    sorted = [...tracks].sort((a, b) => Math.abs(a.duration - duration) - Math.abs(b.duration - duration));
  }
  const results: string[] = [];
  let count = 0;
  let emittedPlain = false;
  const matchesDuration = (t: LrcLibTrack) =>
    duration === -1 || Math.abs(t.duration - duration) <= LRCLIB_MAX_DURATION_DELTA;
  for (const track of sorted) {
    if (count >= LRCLIB_MAX_RESULTS) break;
    if (!matchesDuration(track)) continue;
    if (track.syncedLyrics && track.syncedLyrics.trim()) {
      results.push(track.syncedLyrics);
      count += 1;
    }
    if (!emittedPlain && count < LRCLIB_MAX_RESULTS) {
      if (track.plainLyrics && track.plainLyrics.trim()) {
        results.push(track.plainLyrics);
        count += 1;
        emittedPlain = true;
      }
    }
  }
  return results;
};

// ── KuGou ──────────────────────────────────────────────────────────────────

const KUGOW_PAGE_SIZE = 8;
const KUGOW_HEAD_CUT_LIMIT = 30;
const KUGOW_DURATION_TOLERANCE = 8;
const KUGOW_ACCEPTED_RE = /\[(\d\d):(\d\d)\.(\d{2,3})\].*/;
const KUGOW_BANNED_RE = /.+].+[:：].+/;

function normalizeKugouTitle(title: string): string {
  let result = title;
  for (const pattern of ['\\(.*\\)', '（.*）', '「.*」', '『.*』', '<.*>', '《.*》', '〈.*〉', '＜.*＞']) {
    result = result.replace(new RegExp(pattern, 'g'), '');
  }
  return result;
}

function normalizeKugouArtist(artist: string): string {
  let result = artist.replace(/, /g, '、').replace(/ & /g, '、').replace(/\./g, '').replace(/和/g, '、');
  result = result.replace(/\(.*\)/g, '').replace(/（.*）/g, '');
  return result;
}

export function generateKugouKeyword(title: string, artist: string): [string, string] {
  return [normalizeKugouTitle(title), normalizeKugouArtist(artist)];
}

function normalizeKugouLyrics(text: string): string {
  const lines = text
    .replace(/&apos;/g, "'")
    .split('\n')
    .filter((line) => KUGOW_ACCEPTED_RE.test(line));
  let headCutLine = 0;
  for (let i = Math.min(KUGOW_HEAD_CUT_LIMIT, lines.length - 1); i >= 0; i--) {
    if (KUGOW_BANNED_RE.test(lines[i])) {
      headCutLine = i + 1;
      break;
    }
  }
  const filtered = lines.slice(headCutLine);
  let tailCutLine = 0;
  const lastIndex = lines.length - 1;
  for (let i = Math.min(lines.length - KUGOW_HEAD_CUT_LIMIT, lastIndex); i >= 0; i--) {
    if (KUGOW_BANNED_RE.test(lines[lastIndex - i])) {
      tailCutLine = i + 1;
      break;
    }
  }
  const final = tailCutLine ? filtered.slice(0, filtered.length - tailCutLine) : filtered;
  return final.join('\n');
}

interface KugouCandidate {
  id: unknown;
  accesskey: string;
}

async function kugouSearchSongs(keyword: [string, string], signal?: AbortSignal): Promise<Record<string, unknown>> {
  const payload = await fetchJsonWithRelay(
    'https://mobileservice.kugou.com/api/v3/search/song',
    {
      version: 9108,
      plat: 0,
      pagesize: KUGOW_PAGE_SIZE,
      showtype: 0,
      keyword: `${keyword[0]} - ${keyword[1]}`,
    },
    undefined,
    signal,
  );
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

async function kugouSearchLyrics(
  params: FetchParams,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const payload = await fetchJsonWithRelay('https://lyrics.kugou.com/search', params, undefined, signal);
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function kugouCandidates(payload: Record<string, unknown>): Record<string, unknown>[] {
  const candidates = payload.candidates;
  if (!Array.isArray(candidates)) return [];
  return candidates.filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null);
}

async function kugouDownload(candidate: Record<string, unknown>, signal?: AbortSignal): Promise<string | null> {
  // The download fetch itself propagates transport failures (direct +
  // relay exhausted) so the chain marks KuGou failed; only decode errors return null.
  const payload = await fetchJsonWithRelay(
      'https://lyrics.kugou.com/download',
      {
        fmt: 'lrc',
        charset: 'utf8',
        client: 'pc',
        ver: 1,
        id: candidate.id as string | number,
        accesskey: String(candidate.accesskey ?? ''),
      },
      undefined,
      signal,
    );
  const content =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? String((payload as Record<string, unknown>).content ?? '')
      : '';
  try {
    return normalizeKugouLyrics(decodeBase64Utf8(content));
  } catch {
    return null;
  }
}

async function kugouCandidate(keyword: [string, string], duration: number, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  const data = kugouSearchSongs(keyword, signal);
  const songsPayload = await data;
  const info = ((songsPayload.data as Record<string, unknown> | undefined)?.info ?? []) as unknown[];
  for (const song of info) {
    if (typeof song !== 'object' || song === null) continue;
    const record = song as Record<string, unknown>;
    const songDuration = Number(record.duration ?? 0) || 0;
    if (duration === -1 || Math.abs(songDuration - duration) <= KUGOW_DURATION_TOLERANCE) {
      const payload = await kugouSearchLyrics(
        { ver: 1, man: 'yes', client: 'pc', hash: String(record.hash ?? '') },
        signal,
      );
      const candidate = kugouCandidates(payload)[0];
      if (candidate) return candidate;
    }
  }
  const payload = await kugouSearchLyrics(
    {
      ver: 1,
      man: 'yes',
      client: 'pc',
      keyword: `${keyword[0]} - ${keyword[1]}`,
      ...(duration !== -1 ? { duration: duration * 1000 } : {}),
    },
    signal,
  );
  return kugouCandidates(payload)[0] ?? null;
}

const kugouGet: ProviderFetch = async (ctx, signal) => {
  const { title, artist, durationSeconds } = cleanCtx(ctx);
  const duration = durationSeconds == null ? -1 : Math.trunc(durationSeconds);
  const keyword = generateKugouKeyword(title, artist);
  const candidate = await kugouCandidate(keyword, duration, signal);
  if (!candidate) return null;
  const text = await kugouDownload(candidate, signal);
  return text && text.trim() ? text : null;
};

const kugouGetAll: ProviderFetchAll = async (ctx, signal) => {
  const { title, artist, durationSeconds } = cleanCtx(ctx);
  const duration = durationSeconds == null ? -1 : Math.trunc(durationSeconds);
  const results: string[] = [];
  {
    const keyword = generateKugouKeyword(title, artist);
    const songsPayload = await kugouSearchSongs(keyword, signal);
    const info = ((songsPayload.data as Record<string, unknown> | undefined)?.info ?? []) as unknown[];
    for (const song of info) {
      if (typeof song !== 'object' || song === null) continue;
      const record = song as Record<string, unknown>;
      if (duration === -1 || Math.abs((Number(record.duration ?? 0) || 0) - duration) <= KUGOW_DURATION_TOLERANCE) {
        const payload = await kugouSearchLyrics(
          { ver: 1, man: 'yes', client: 'pc', hash: String(record.hash ?? '') },
          signal,
        );
        const candidate = kugouCandidates(payload)[0];
        if (candidate) {
          const text = await kugouDownload(candidate, signal);
          if (text) results.push(text);
        }
      }
    }
    const payload = await kugouSearchLyrics(
      {
        ver: 1,
        man: 'yes',
        client: 'pc',
        keyword: `${keyword[0]} - ${keyword[1]}`,
        ...(duration !== -1 ? { duration: duration * 1000 } : {}),
      },
      signal,
    );
    for (const candidate of kugouCandidates(payload)) {
      const text = await kugouDownload(candidate, signal);
      if (text) results.push(text);
    }
  }
  return results;
};

// ── Megalobiz ──────────────────────────────────────────────────────────────
// Megalobiz public lyrics API (no key needed). The old
// `www.megalobiz.com/searchall` HTML scrape is dead: the site was
// rebuilt as a Next.js app and `/searchall` answers 404, with no
// `/lrc/maker/download/` links anywhere in the markup. The documented
// anonymous API (GET https://api.megalobiz.com/api/public/v1) returns
// scored search results; the first result's LRC document is fetched
// and returned only when it is line-synced LRC, as before.

const MEGALOBIZ_API = 'https://api.megalobiz.com/api/public/v1';

const megalobizGet: ProviderFetch = async (ctx, signal) => {
  const { title, artist, durationSeconds } = cleanCtx(ctx);
  if (!title || !artist) return null;
  const params: FetchParams = { title, artist };
  if (durationSeconds != null && durationSeconds > 0) params.duration = durationSeconds;
  const search = await fetchTextWithRelay(`${MEGALOBIZ_API}/search`, params, undefined, signal);
  throwIfUpstreamFailure(search);
  if (search.status < 200 || search.status > 299) return null;
  const payload = parseJsonLenient(search.text);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const results = (payload as Record<string, unknown>).results;
  if (!Array.isArray(results) || !results.length) return null;
  const first = results[0] as Record<string, unknown> | undefined;
  const id = first?.id;
  if (id == null) return null;
  const detail = await fetchTextWithRelay(`${MEGALOBIZ_API}/lrc/${id}`, { format: 'lrc' }, undefined, signal);
  throwIfUpstreamFailure(detail);
  if (detail.status < 200 || detail.status > 299) return null;
  const cleaned = detail.text.trim();
  return isLineSyncedLrc(cleaned) ? cleaned : null;
};

// ── SimpMusic ──────────────────────────────────────────────────────────────

const SIMPMUSIC_BASE = 'https://api-lyrics.simpmusic.org/v1/';

interface SimpMusicTrack {
  durationSeconds: number;
  syncedLyrics: string | null;
  plainLyric: string | null;
}

async function simpMusicTracks(videoId: string, signal?: AbortSignal): Promise<SimpMusicTrack[]> {
  if (!videoId) return [];
  const result = await fetchTextWithRelay(
    SIMPMUSIC_BASE + videoId,
    undefined,
    { Accept: 'application/json' },
    signal,
  );
  // SimpMusic now answers 403 "only available to SimpMusic clients"
  // on every transport: an upstream gate, not "no lyrics". The gate
  // is the User-Agent header, proven live 2026-11-03: the exact
  // Android request (`User-Agent: SimpMusicLyrics/1.0`, from
  // `SimpMusicLyrics.kt`) returns 200 with real lyrics, any other
  // UA (browser UA, curl default, the cors.dev relay's own UA)
  // returns 403, and the check is a prefix match on
  // "SimpMusicLyrics". A browser cannot set User-Agent (forbidden
  // fetch header) and neither public relay forwards a caller-set
  // UA — cors.dev overwrites it with its own and drops custom
  // headers (verified against an echo endpoint), AllOrigins was
  // 522/520, corsproxy.io needs an API key, Corsfix needs the
  // domain registered in its dashboard. There is therefore no
  // browser-side route to this API today; the failure label says
  // so honestly instead of pretending the provider is down.
  throwIfUpstreamFailure(result);
  if (result.status !== 200) return [];
  const payload = parseJsonLenient(result.text);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return [];
  if ((payload as Record<string, unknown>).type !== 'success') return [];
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  return data
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      durationSeconds: Number(item.durationSeconds ?? 0) || 0,
      syncedLyrics: typeof item.syncedLyrics === 'string' ? item.syncedLyrics : null,
      plainLyric: typeof item.plainLyric === 'string' ? item.plainLyric : null,
    }));
}

const simpmusicGet: ProviderFetch = async (ctx, signal) => {
  const { videoId, durationSeconds } = cleanCtx(ctx);
  const duration = durationSeconds == null ? 0 : Math.trunc(durationSeconds);
  const tracks = await simpMusicTracks(videoId, signal);
  if (!tracks.length) return null;
  let best = tracks[0];
  if (duration > 0 && tracks.length > 1) {
    best = tracks.reduce((a, b) =>
      Math.abs(b.durationSeconds - duration) < Math.abs(a.durationSeconds - duration) ? b : a,
    );
  }
  return best.syncedLyrics ?? best.plainLyric ?? null;
};

const simpmusicGetAll: ProviderFetchAll = async (ctx, signal) => {
  const { videoId, durationSeconds } = cleanCtx(ctx);
  const duration = durationSeconds == null ? 0 : Math.trunc(durationSeconds);
  const tracks = await simpMusicTracks(videoId, signal);
  const sorted =
    duration > 0
      ? [...tracks].sort((a, b) => Math.abs(a.durationSeconds - duration) - Math.abs(b.durationSeconds - duration))
      : tracks;
  const results: string[] = [];
  let count = 0;
  let plain = 0;
  for (const track of sorted) {
    if (count <= 4) {
      if (track.syncedLyrics != null && Math.abs(track.durationSeconds - duration) <= 5) {
        count += 1;
        results.push(track.syncedLyrics);
      }
      if (
        track.plainLyric != null &&
        Math.abs(track.durationSeconds - duration) <= 5 &&
        plain === 0
      ) {
        count += 1;
        plain += 1;
        results.push(track.plainLyric);
      }
    }
  }
  return results;
};

// ── Unison ─────────────────────────────────────────────────────────────────

const UNISON_BASE = 'https://unison.boidu.dev/';
const UNISON_MAX_RESULTS = 5;

interface UnisonEntry {
  lyrics: string;
}

async function unisonGetJson(
  path: string,
  params: FetchParams | undefined,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const result = await fetchTextWithRelay(UNISON_BASE + path, params, undefined, signal);
  throwIfUpstreamFailure(result);
  if (result.status < 200 || result.status > 299) return null;
  const payload = parseJsonLenient(result.text);
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function unisonEntryWithLyrics(payload: Record<string, unknown>): UnisonEntry | null {
  if (!payload.success) return null;
  const data = payload.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const lyrics = (data as Record<string, unknown>).lyrics;
  return typeof lyrics === 'string' && lyrics.trim() ? { lyrics } : null;
}

function unisonToEntry(summary: Record<string, unknown>): UnisonEntry | null {
  const lyrics = summary.lyrics;
  return typeof lyrics === 'string' && lyrics.trim() ? { lyrics } : null;
}

async function unisonFetchByVideoId(videoId: string, signal?: AbortSignal): Promise<UnisonEntry | null> {
  const payload = await unisonGetJson('lyrics', { v: videoId }, signal);
  return payload ? unisonEntryWithLyrics(payload) : null;
}

async function unisonFetchById(entryId: unknown, signal?: AbortSignal): Promise<UnisonEntry | null> {
  const payload = await unisonGetJson(`lyrics/${entryId}`, undefined, signal);
  return payload ? unisonEntryWithLyrics(payload) : null;
}

async function unisonSearchEntries(
  title: string,
  artist: string,
  album: string,
  durationSeconds: number | null,
  signal?: AbortSignal,
): Promise<UnisonEntry[]> {
  const cleanTitle = title.trim();
  const cleanArtist = artist.trim();
  if (!cleanTitle || !cleanArtist) return [];
  const params: FetchParams = { song: cleanTitle, artist: cleanArtist, limit: UNISON_MAX_RESULTS };
  if (album.trim()) params.album = album.trim();
  if (durationSeconds != null && durationSeconds > 0) params.duration = durationSeconds;
  let payload: Record<string, unknown> | null;
  try {
    payload = await unisonGetJson('lyrics/search', params, signal);
  } catch {
    return [];
  }
  if (!payload || !payload.success) return [];
  const summaries = payload.data;
  if (!Array.isArray(summaries)) return [];
  const entries: UnisonEntry[] = [];
  for (const summary of summaries) {
    if (entries.length >= UNISON_MAX_RESULTS) break;
    if (typeof summary !== 'object' || summary === null) continue;
    const record = summary as Record<string, unknown>;
    let entry = unisonToEntry(record);
    if (!entry) {
      const videoId = record.videoId;
      if (videoId && String(videoId).trim()) {
        try {
          entry = await unisonFetchByVideoId(String(videoId), signal);
        } catch {
          entry = null;
        }
      }
      if (!entry) {
        try {
          entry = await unisonFetchById(record.id, signal);
        } catch {
          entry = null;
        }
      }
    }
    if (entry) entries.push(entry);
  }
  return entries;
}

async function unisonFetchVariants(videoId: string, signal?: AbortSignal): Promise<UnisonEntry[]> {
  const payload = await unisonGetJson(`lyrics/variants/${videoId}`, undefined, signal);
  if (!payload || !payload.success) return [];
  const entries: UnisonEntry[] = [];
  const data = payload.data;
  if (!Array.isArray(data)) return [];
  for (const summary of data) {
    if (typeof summary === 'object' && summary !== null) {
      const entry = unisonToEntry(summary as Record<string, unknown>);
      if (entry) entries.push(entry);
    }
    if (entries.length >= UNISON_MAX_RESULTS) break;
  }
  return entries;
}

const unisonGet: ProviderFetch = async (ctx, signal) => {
  const { videoId, title, artist, album, durationSeconds } = cleanCtx(ctx);
  const entries = await unisonSearchEntries(title, artist, album, durationSeconds, signal);
  if (entries.length) return entries[0].lyrics;
  const cleanVideoId = videoId.trim();
  if (!cleanVideoId) return null;
  const entry = await unisonFetchByVideoId(cleanVideoId, signal);
  return entry?.lyrics ?? null;
};

const unisonGetAll: ProviderFetchAll = async (ctx, signal) => {
  const { videoId, title, artist, album, durationSeconds } = cleanCtx(ctx);
  let results = await unisonSearchEntries(title, artist, album, durationSeconds, signal);
  if (!results.length) {
    const cleanVideoId = videoId.trim();
    if (cleanVideoId) {
      results = await unisonFetchVariants(cleanVideoId, signal);
      if (!results.length) {
        const entry = await unisonFetchByVideoId(cleanVideoId, signal);
        results = entry ? [entry] : [];
      }
    }
  }
  return results.slice(0, UNISON_MAX_RESULTS).map((e) => e.lyrics);
};

// ── Paxsenix ───────────────────────────────────────────────────────────────

const PAXSENIX_BASE = 'https://api.paxsenix.org/';
const PAXSENIX_MIN_SCORE = 10;
const PAXSENIX_TRACK_ID_KEYS = ['id', 'trackId', 'track_id', 'realId'];
const PAXSENIX_TRACK_TITLE_KEYS = ['name', 'title', 'trackName', 'track_name'];
const PAXSENIX_TRACK_ARTIST_KEYS = ['artistName', 'artist_name'];
const PAXSENIX_TRACK_DURATION_KEYS = ['durationInMillis', 'durationMs', 'duration_ms', 'duration'];
const PAXSENIX_LYRICS_CONTENT_KEYS = [
  'lyrics', 'lrc', 'content', 'lines', 'text', 'plainLyrics', 'syncedLyrics', 'line', 'lyric',
];

function paxsenixHeaders(apiKey: string): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Authorization: `Bearer ${apiKey}`,
  };
}

async function paxsenixApiBody(
  path: string,
  apiKey: string,
  params: FetchParams | undefined,
  signal?: AbortSignal,
): Promise<string> {
  // Direct-only on purpose: the Authorization header must never travel
  // through a CORS relay. Paxsenix already sends ACAO *, so a direct
  // failure simply means this provider returns nothing here.
  const { status, text } = await fetchText(PAXSENIX_BASE + path, params, paxsenixHeaders(apiKey), signal);
  if (status < 200 || status > 299) throw new Error(`Paxsenix request failed with HTTP ${status}`);
  return text;
}

function isErrorPayload(obj: Record<string, unknown>): boolean {
  const isError = obj.isError;
  if (typeof isError === 'boolean' && isError) return true;
  const ok = obj.ok;
  if (typeof ok === 'boolean' && !ok) return true;
  const error = obj.error;
  if (error == null) return false;
  if (typeof error === 'boolean') return error;
  if (typeof error === 'string') return Boolean(error.trim());
  if (Array.isArray(error)) return error.length > 0;
  if (typeof error === 'object') return Object.keys(error).length > 0;
  return false;
}

function extractLyrics(element: unknown): string | null {
  if (element == null || typeof element === 'boolean' || typeof element === 'number') return null;
  if (typeof element === 'string') {
    const value = element.trim();
    if (!value) return null;
    const nested = parseJsonLenient(value);
    if (nested != null && typeof nested !== 'string' && typeof nested !== 'number' && typeof nested !== 'boolean') {
      return extractLyrics(nested);
    }
    return value;
  }
  if (Array.isArray(element)) {
    const joined = element.map((item) => extractLyrics(item)).filter(Boolean).join('\n').trim();
    return joined || null;
  }
  if (typeof element === 'object') {
    const dict = element as Record<string, unknown>;
    if (isErrorPayload(dict)) return null;
    for (const key of PAXSENIX_LYRICS_CONTENT_KEYS) {
      if (key in dict) {
        const found = extractLyrics(dict[key]);
        if (found != null) return found;
      }
    }
    const metadata = dict.metadata;
    if (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)) {
      const meta = metadata as Record<string, unknown>;
      for (const key of PAXSENIX_LYRICS_CONTENT_KEYS) {
        if (key in meta) {
          const found = extractLyrics(meta[key]);
          if (found != null) return found;
        }
      }
    }
    const words = dict.words;
    if (words != null) {
      if (Array.isArray(words)) {
        const joined = words.map((item) => extractLyrics(item)).filter(Boolean).join(' ').trim();
        return joined || null;
      }
      return extractLyrics(words);
    }
    return null;
  }
  return null;
}

function cleanJsonLyrics(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const payload = parseJsonLenient(trimmed);
  if (payload == null) return trimmed;
  return extractLyrics(payload);
}

function convertAppleMusicToLrc(response: Record<string, unknown>): string {
  const lines: string[] = [];
  const content = response.content;
  if (!Array.isArray(content)) return '';
  for (const line of content) {
    if (typeof line !== 'object' || line === null) continue;
    const record = line as Record<string, unknown>;
    const timestamp = Number(record.timestamp ?? 0) || 0;
    const minutes = Math.floor(timestamp / 1000 / 60);
    const seconds = Math.floor(timestamp / 1000) % 60;
    const hundredths = Math.floor((timestamp % 1000) / 10);
    const time = `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}]`;
    const words = record.text;
    const text = Array.isArray(words)
      ? words
          .filter((w): w is Record<string, unknown> => typeof w === 'object' && w !== null)
          .map((w) => String(w.text ?? '').trim())
          .join(' ')
      : '';
    lines.push(`${time}${text}`);
  }
  return lines.join('\n');
}

function parsePaxsenixLyrics(raw: string): string | null {
  const payload = parseJsonLenient(raw);
  if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
    const content = (payload as Record<string, unknown>).content;
    if (Array.isArray(content) && content.length) {
      const converted = convertAppleMusicToLrc(payload as Record<string, unknown>);
      if (converted.trim()) return converted;
    }
  }
  return cleanJsonLyrics(raw);
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'boolean' || value == null) continue;
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return null;
}

function firstLong(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'boolean' || value == null) continue;
    if (typeof value === 'number') return Math.trunc(value);
    if (typeof value === 'string') {
      const n = Number.parseInt(value.trim(), 10);
      if (!Number.isNaN(n)) return n;
    }
  }
  return null;
}

function artistNames(obj: Record<string, unknown>): string | null {
  const artists = obj.artists ?? obj.artist;
  if (artists == null) return null;
  if (typeof artists === 'string') return artists;
  if (typeof artists === 'object' && !Array.isArray(artists)) {
    return firstString(artists as Record<string, unknown>, ['name', 'artistName', 'title']);
  }
  if (Array.isArray(artists)) {
    const names: string[] = [];
    for (const artist of artists) {
      if (typeof artist === 'string') names.push(artist);
      else if (typeof artist === 'object' && artist !== null) {
        const name = firstString(artist as Record<string, unknown>, ['name', 'artistName', 'title']);
        if (name) names.push(name);
      }
    }
    return names.join(', ') || null;
  }
  return null;
}

function toDurationMs(value: number | null): number {
  if (value == null || value <= 0) return 0;
  return value < 10000 ? value * 1000 : value;
}

interface TrackCandidate {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
}

function toTrackCandidate(obj: Record<string, unknown>): TrackCandidate | null {
  const attributes = obj.attributes;
  const details =
    typeof attributes === 'object' && attributes !== null && !Array.isArray(attributes)
      ? (attributes as Record<string, unknown>)
      : obj;
  const candidateId = firstString(obj, PAXSENIX_TRACK_ID_KEYS) ?? firstString(details, PAXSENIX_TRACK_ID_KEYS);
  if (!candidateId) return null;
  const title = firstString(details, PAXSENIX_TRACK_TITLE_KEYS);
  if (!title) return null;
  const artist = firstString(details, PAXSENIX_TRACK_ARTIST_KEYS) ?? artistNames(details);
  const duration = toDurationMs(firstLong(details, PAXSENIX_TRACK_DURATION_KEYS));
  return { id: candidateId, title, artist: artist ?? '', durationMs: duration };
}

function collectCandidates(element: unknown, destination: TrackCandidate[]): void {
  if (Array.isArray(element)) {
    for (const item of element) collectCandidates(item, destination);
  } else if (typeof element === 'object' && element !== null) {
    const dict = element as Record<string, unknown>;
    const candidate = toTrackCandidate(dict);
    if (candidate) destination.push(candidate);
    for (const value of Object.values(dict)) collectCandidates(value, destination);
  }
}

function textMatchScore(candidate: string, requested: string, exactScore: number, partialScore: number): number {
  if (!candidate.trim() || !requested.trim()) return 0;
  if (candidate.toLowerCase() === requested.toLowerCase()) return exactScore;
  if (
    candidate.toLowerCase().includes(requested.toLowerCase()) ||
    requested.toLowerCase().includes(candidate.toLowerCase())
  ) {
    return partialScore;
  }
  return 0;
}

function scoreCandidate(candidate: TrackCandidate, title: string, artist: string, durationMs: number): number {
  let score = textMatchScore(candidate.title, title, 20, 10);
  score += textMatchScore(candidate.artist, artist, 15, 5);
  if (durationMs > 0 && candidate.durationMs > 0) {
    const difference = Math.abs(candidate.durationMs - durationMs);
    if (difference < 3000) score += 10;
    else if (difference < 10000) score += 5;
  }
  return score;
}

async function searchTrackId(
  path: string,
  title: string,
  artist: string,
  durationMs: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const raw = await paxsenixApiBody(path, apiKey, { q: `${title} ${artist}` }, signal);
  const payload = parseJsonLenient(raw);
  const candidates: TrackCandidate[] = [];
  if (payload != null) collectCandidates(payload, candidates);
  let best: TrackCandidate | null = null;
  let bestScore: number | null = null;
  for (const candidate of candidates) {
    const score = scoreCandidate(candidate, title, artist, durationMs);
    if (bestScore == null || score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best != null && bestScore != null && bestScore >= PAXSENIX_MIN_SCORE ? best.id : null;
}

function requireKey(apiKey: string | undefined): string | null {
  const key = apiKey?.trim();
  return key || null;
}

async function paxsenixAppleMusic(ctx: ProviderContext, signal?: AbortSignal): Promise<string | null> {
  const { title, artist, durationSeconds } = cleanCtx(ctx);
  const key = requireKey(ctx.paxsenixKey);
  if (!key) return null;
  const songId = await searchTrackId(
    'apple-music/search',
    title,
    artist,
    Math.max(0, durationSeconds ?? 0) * 1000,
    key,
    signal,
  );
  if (!songId) return null;
  const raw = await paxsenixApiBody('lyrics/applemusic', key, { id: songId }, signal);
  return parsePaxsenixLyrics(raw);
}

async function paxsenixSpotify(ctx: ProviderContext, signal?: AbortSignal): Promise<string | null> {
  const { title, artist, durationSeconds } = cleanCtx(ctx);
  const key = requireKey(ctx.paxsenixKey);
  if (!key) return null;
  const trackId = await searchTrackId(
    'spotify/search',
    title,
    artist,
    Math.max(0, durationSeconds ?? 0) * 1000,
    key,
    signal,
  );
  if (!trackId) return null;
  const raw = await paxsenixApiBody('lyrics/spotify', key, { id: trackId }, signal);
  return parsePaxsenixLyrics(raw);
}

async function paxsenixMusixmatch(ctx: ProviderContext, signal?: AbortSignal): Promise<string | null> {
  const { title, artist, durationSeconds } = cleanCtx(ctx);
  const key = requireKey(ctx.paxsenixKey);
  if (!key) return null;
  const duration = durationSeconds == null ? -1 : Math.trunc(durationSeconds);
  const raw = await paxsenixApiBody(
    'lyrics/musixmatch',
    key,
    { t: title, a: artist, d: String(duration) },
    signal,
  );
  return parsePaxsenixLyrics(raw);
}

function wrapPaxsenix(getter: ProviderFetch): { getLyrics: ProviderFetch; getAllLyrics: ProviderFetchAll } {
  const getLyrics: ProviderFetch = async (ctx, signal) => {
    const result = await getter(ctx, signal);
    return result && result.trim() ? result : null;
  };
  const getAllLyrics: ProviderFetchAll = async (ctx, signal) => {
    const result = await getLyrics(ctx, signal);
    return result ? [result] : [];
  };
  return { getLyrics, getAllLyrics };
}

// ── YouTube (browser) ────────────────────────────────────────────────────

function toYoutubeQuery(ctx: ProviderContext): YoutubeQuery {
  const clean = cleanCtx(ctx);
  return {
    videoId: clean.videoId,
    title: clean.title,
    artist: clean.artist,
    album: clean.album,
    durationSeconds: clean.durationSeconds,
  };
}

const youtubeSubtitleGet: ProviderFetch = (ctx, signal) =>
  getYoutubeSubtitleLyrics(toYoutubeQuery(ctx), signal);
const youtubeMusicGet: ProviderFetch = (ctx, signal) =>
  getYoutubeMusicLyrics(toYoutubeQuery(ctx), signal);

// ── Registry ───────────────────────────────────────────────────────────────

async function buildRegistry(): Promise<ProviderDefinition[]> {
  const paxApple = wrapPaxsenix(paxsenixAppleMusic);
  const paxSpotify = wrapPaxsenix(paxsenixSpotify);
  const paxMusixmatch = wrapPaxsenix(paxsenixMusixmatch);
  const betterAll = await singleAsAll(betterLyricsGet);
  const portatoAll = await singleAsAll(portatoGet);
  const youlyAll = await singleAsAll(youLyPlusGet);
  const megaAll = await singleAsAll(megalobizGet);
  const subtitleAll = await singleAsAll(youtubeSubtitleGet);
  const musicAll = await singleAsAll(youtubeMusicGet);
  return [
    { id: 'betterlyrics', name: 'BetterLyrics', requiresKey: false, alwaysUnavailable: false, getLyrics: betterLyricsGet, getAllLyrics: betterAll },
    { id: 'betterlyrics-portato', name: 'BetterLyrics Portato', requiresKey: false, alwaysUnavailable: false, getLyrics: portatoGet, getAllLyrics: portatoAll },
    { id: 'youlyplus', name: 'YouLyPlus', requiresKey: false, alwaysUnavailable: false, getLyrics: youLyPlusGet, getAllLyrics: youlyAll },
    { id: 'lrclib', name: 'LrcLib', requiresKey: false, alwaysUnavailable: false, getLyrics: lrclibGet, getAllLyrics: lrclibGetAll },
    { id: 'kugou', name: 'Kugou', requiresKey: false, alwaysUnavailable: false, getLyrics: kugouGet, getAllLyrics: kugouGetAll },
    { id: 'megalobiz', name: 'Megalobiz', requiresKey: false, alwaysUnavailable: false, getLyrics: megalobizGet, getAllLyrics: megaAll },
    { id: 'simpmusic', name: 'SimpMusic', requiresKey: false, alwaysUnavailable: false, getLyrics: simpmusicGet, getAllLyrics: simpmusicGetAll,
      describeFailed: () => 'Only available to SimpMusic clients' },
    { id: 'unison', name: 'Unison', requiresKey: false, alwaysUnavailable: false, getLyrics: unisonGet, getAllLyrics: unisonGetAll },
    { id: 'paxsenix-apple-music', name: 'Paxsenix: Apple Music', requiresKey: true, alwaysUnavailable: false, getLyrics: paxApple.getLyrics, getAllLyrics: paxApple.getAllLyrics },
    { id: 'paxsenix-spotify', name: 'Paxsenix: Spotify', requiresKey: true, alwaysUnavailable: false, getLyrics: paxSpotify.getLyrics, getAllLyrics: paxSpotify.getAllLyrics },
    { id: 'paxsenix-musixmatch', name: 'Paxsenix: Musixmatch', requiresKey: true, alwaysUnavailable: false, getLyrics: paxMusixmatch.getLyrics, getAllLyrics: paxMusixmatch.getAllLyrics },
    { id: 'youtube-subtitle', name: 'YouTube Subtitle', requiresKey: false, alwaysUnavailable: false, getLyrics: youtubeSubtitleGet, getAllLyrics: subtitleAll,
      describeEmpty: (ctx) => {
        const status = getSubtitleStatus(ctx.videoId);
        if (status === 'no-captions') return 'no-captions';
        if (status === 'gated') return 'gated';
        if (status === 'unresolved') return 'unresolved';
        return null;
      } },
    { id: 'youtube-music', name: 'YouTube Music', requiresKey: false, alwaysUnavailable: false, getLyrics: youtubeMusicGet, getAllLyrics: musicAll },
  ];
}

// Built synchronously at module load: singleAsAll needs no async work in
// practice, but keep the registry construction simple and deterministic
// by resolving it once here.
let registryPromise: Promise<ProviderDefinition[]> | null = null;

export function getProviderRegistry(): Promise<ProviderDefinition[]> {
  if (!registryPromise) registryPromise = buildRegistry();
  return registryPromise;
}

export function providerName(id: string): string {
  return LYRICS_CHAIN.find((p) => p.id === id)?.label ?? id;
}

export function isProviderAvailable(def: ProviderDefinition, paxsenixKey?: string): boolean {
  if (def.alwaysUnavailable) return false;
  if (def.requiresKey) return Boolean(paxsenixKey?.trim());
  return true;
}

export function resolveClientOrder(
  order: readonly string[] | null | undefined,
  enabled: Record<string, boolean> | null | undefined,
): string[] {
  const base = order?.length ? [...order] : [...LYRICS_CHAIN_IDS];
  const known = base.filter((id) => LYRICS_CHAIN_IDS.includes(id));
  const seen = new Set<string>();
  const deduped = known.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
  return deduped.filter((id) => enabled?.[id] !== false);
}
