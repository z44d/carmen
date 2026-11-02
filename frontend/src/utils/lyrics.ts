/**
 * Lyrics helpers shared by the player's lyrics panel and the download
 * pipeline, so what is on screen and what lands in `track.json` are the same
 * text.
 */
import type { LyricLine, LyricWord, TrackLyrics, TrackMeta } from '../types/models';

/** Enhanced-LRC per-word stamps: `<mm:ss.xx>` (or `.x` / `.xxx`) tags. */
const WORD_TAG = /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g;

/** Fallback line span when neither `endTimeMs` nor a next line exists (ms/word). */
const ESTIMATED_WORD_MS = 350;
/** Never slower than this per word — a silence after the last line must not crawl. */
const MAX_WORD_MS = 800;
/** Never faster than this — mangled stamps must not turn into flicker. */
const MIN_WORD_MS = 120;

/** `mm:ss.frac` → milliseconds (shared by line and word stamps). */
function stampToMs(minutes: string, seconds: string, fraction: string | undefined): number {
  const frac = fraction ?? '0';
  return Number(minutes) * 60000 + Number(seconds) * 1000 + Number(frac.padEnd(3, '0').slice(0, 3));
}

/**
 * Word stamps out of one enhanced-LRC line body, or `null` when the line is
 * plain (no `<…>` tags). Each word's end is the next word's start; the very
 * last one gets a provisional end that the line below replaces with the next
 * line's timestamp.
 */
function parseWords(body: string): LyricWord[] | null {
  const stamps: { at: number; from: number; startMs: number }[] = [];
  WORD_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD_TAG.exec(body))) {
    stamps.push({
      at: match.index,
      from: match.index + match[0].length,
      startMs: stampToMs(match[1], match[2], match[3]),
    });
  }
  if (!stamps.length) return null;
  const words: LyricWord[] = [];
  for (let i = 0; i < stamps.length; i++) {
    const text = body.slice(stamps[i].from, stamps[i + 1]?.at ?? body.length).trim();
    if (!text) continue;
    words.push({
      text,
      startMs: stamps[i].startMs,
      endMs: stamps[i + 1]?.startMs ?? stamps[i].startMs + 500,
    });
  }
  return words.length ? words : null;
}

/** Parse an `.lrc` document into timed lines (used for offline lyrics). */
export function parseLrc(text: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const pattern = /^\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\](.*)$/;
  for (const raw of text.split(/\r?\n/)) {
    const match = pattern.exec(raw.trim());
    if (!match) continue;
    const ms = stampToMs(match[1], match[2], match[3]);
    const body = (match[4] ?? '').trim();
    const words = parseWords(body);
    lines.push({
      timeMs: ms,
      // Word tags are stamps, not lyrics — strip them from the visible text.
      text: words ? body.replace(WORD_TAG, '').replace(/\s+/g, ' ').trim() : body,
      ...(words ? { words } : {}),
    });
  }
  // The last word of a line ends when the next line begins (bounded: a
  // malformed document where lines overlap must not run words backwards).
  for (let i = 0; i + 1 < lines.length; i++) {
    const words = lines[i].words;
    const last = words?.[words.length - 1];
    const nextStart = lines[i + 1].timeMs;
    if (last && nextStart > last.startMs) last.endMs = nextStart;
  }
  return lines;
}

/**
 * Karaoke word timings for a line — the source's own stamps when it carries
 * enhanced-LRC word tags, otherwise the plain text spread across the line:
 * `(line end − line start) ÷ word count`, where the line's end is its
 * `endTimeMs`, the next line's start, or a typical spoken slot for the last
 * line. One even slot per word, clamped so trailing silence can't make the
 * words crawl and broken stamps can't make them flicker.
 */
export function karaokeWordsOf(line: LyricLine, nextStartMs?: number): LyricWord[] {
  if (line.words?.length) return line.words;
  const tokens = line.text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const start = line.timeMs;
  const end = line.endTimeMs ?? nextStartMs ?? start + tokens.length * ESTIMATED_WORD_MS;
  const slot = Math.min(Math.max((end - start) / tokens.length, MIN_WORD_MS), MAX_WORD_MS);
  return tokens.map((text, index) => ({
    text,
    startMs: Math.round(start + index * slot),
    endMs: Math.round(start + (index + 1) * slot),
  }));
}

/** Timestamped lines of a track payload, or `null` when there are none. */
export function syncedLines(meta: TrackMeta | null | undefined): LyricLine[] | null {
  const lines = meta?.lyrics?.synced;
  return Array.isArray(lines) && lines.length ? lines : null;
}

/**
 * Whether a line reads right-to-left — port of Android's `isRtlText`
 * (`LyricsV2`): the first strong-directional character decides. Used
 * to set `dir` on lyric rows so Arabic/Hebrew lines align and wrap
 * the way the Android app renders them.
 */
export function isRtlText(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // Hebrew, Arabic, and related RTL blocks (incl. presentation forms).
    if (
      (code >= 0x0590 && code <= 0x08ff) ||
      (code >= 0xfb1d && code <= 0xfdff) ||
      (code >= 0xfe70 && code <= 0xfeff) ||
      (code >= 0x10800 && code <= 0x10fff)
    ) {
      return true;
    }
    // ASCII letters, Cyrillic, CJK and Hangul are strong LTR; digits
    // are bidi-weak (European numbers) — Android's getDirectionality
    // skips them, so they must not decide the direction either.
    if (
      (code >= 0x0041 && code <= 0x005a) ||
      (code >= 0x0061 && code <= 0x007a) ||
      (code >= 0x0400 && code <= 0x04ff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      return false;
    }
  }
  return false;
}

/** The plain unsynced text of a track payload, or `null`. */
export function plainLyrics(meta: TrackMeta | null | undefined): string | null {
  const text = meta?.lyrics?.unsynced;
  return typeof text === 'string' && text.trim() ? text : null;
}

/** Lyrics container with a defensive default — used all over the UI. */
export function lyricsOf(meta: TrackMeta | null | undefined): TrackLyrics {
  return meta?.lyrics ?? { synced: null, unsynced: null, source: null };
}

/**
 * Index of the last line whose timestamp has passed — a binary search, so
 * every playhead tick costs `O(log n)` and nothing else.
 *
 * Shared by the lyrics panel and the lock-screen lyric mirror
 * (`services/mediaSession/lockScreenLyrics`) so both highlight exactly the
 * same line at exactly the same millisecond.
 *
 * @returns `-1` before the first line (intro, ads, instrumental leads)
 */
export function activeLineIndexAt(lines: LyricLine[], timeMs: number): number {
  let low = 0;
  let high = lines.length - 1;
  let answer = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle].timeMs <= timeMs) {
      answer = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return answer;
}
