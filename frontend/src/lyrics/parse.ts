/**
 * Lyric text parsing — a TypeScript port of `server/lyrics/parse.py`
 * (Android `LyricsUtils`, minus romanization generation).
 *
 * Returns `{synced, unsynced, quality}` where quality is 2 = word-synced,
 * 1 = line-synced (including TTML), 0 = plain text. Synced lines use the
 * same `LyricLine` shape the UI already consumes.
 *
 * This is separate from `utils/lyrics.ts:parseLrc` (the offline path):
 * that helper keeps its simple shape and tests untouched, while this
 * parser adds translation merging, millisecond/YRC lines, TTML/QRC,
 * and instrumental-break insertion exactly as the server chain does.
 */
import type { LyricLine, LyricWord } from '../types/models';
import { isQrc, parseQrc, qrcHasWordTimings } from './qrc';
import { parseTtml, type TtmlLine } from './ttml';

const LINE_RE = /^((\[\d{1,3}:\d{2}(?:[.:]\d{2,3})?\]\s*)+)(.*)$/;
const TIME_RE = /\[(\d{1,3}):(\d{2})(?:[.:](\d{2,3}))?\]/g;
const WHITESPACE_RE = /\s+/g;
const ENHANCED_WORD_TIME_RE = /<(\d{1,3}):(\d{2})(?:[.:](\d{2,3}))?>/g;
const INLINE_MS_TIME_RE = /<\d{1,8}(?:,\d{1,8})?>/g;
const YRC_LINE_RE = /^\[(\d{1,8}),\d{1,8}\](.*)$/;
const YRC_WORD_TIME_RE = /\(\d{1,8},\d{1,8}(?:,\d{1,8})?\)/g;
const TTML_SPAN_RE = /<span\b[^>]*>/gi;
const TTML_BEGIN_ATTR_RE = /\bbegin\s*=/i;
const TTML_END_ATTR_RE = /\b(?:end|dur)\s*=/i;
const INVISIBLE_CHARS_RE = /[​‌‍⁠­]/g;
const LYRICS_NOT_FOUND = 'LYRICS_NOT_FOUND';
const DEFAULT_ENHANCED_WORD_DURATION_MS = 1000;
const INSTRUMENTAL_GAP_THRESHOLD_MS = 5000;
const INSTRUMENTAL_INTRO_START_MS = 1000;
const INSTRUMENTAL_OUTRO_VOCAL_TAIL_MS = 2500;

export interface ParsedLyrics {
  synced: LyricLine[] | null;
  unsynced: string | null;
  quality: 0 | 1 | 2;
}

interface EntryWord {
  text: string;
  start: number;
  end: number;
  isBackground: boolean;
}

interface ParsedEntry {
  time: number;
  endMs?: number;
  text: string;
  words?: EntryWord[] | null;
  agent?: string | null;
  durationMs?: number;
  translation?: string;
  romanizedText?: string | null;
  romanizedWords?: string[] | null;
  romanizedLanguage?: string | null;
  isInstrumental?: boolean;
}

export function normalizeLyricsText(lyrics: string): string {
  const raw = lyrics.replace(INVISIBLE_CHARS_RE, '').replace(/﻿/g, '').trim();
  const unwrapped = stripCodeFence(raw);
  if (isEscapedTtml(unwrapped)) {
    return unwrapped
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .trim();
  }
  return unwrapped.trim();
}

function stripCodeFence(lyrics: string): string {
  if (!lyrics.startsWith('```')) return lyrics;
  const lines = lyrics.split('\n');
  if (lines.length <= 1) return lyrics;
  const remaining = lines.slice(1);
  if (remaining.length && remaining[remaining.length - 1].trim() === '```') remaining.pop();
  return remaining.join('\n').trim();
}

function isEscapedTtml(lyrics: string): boolean {
  const trimmed = lyrics.trimStart();
  const lowered = trimmed.toLowerCase();
  return (
    lowered.startsWith('&lt;tt') ||
    lowered.includes('&lt;tt') ||
    (lowered.includes('http://www.w3.org/ns/ttml') && lowered.includes('&lt;'))
  );
}

export function isTtml(lyrics: string): boolean {
  const trimmed = normalizeLyricsText(lyrics);
  if (!trimmed.startsWith('<')) return false;
  const lowered = trimmed.toLowerCase();
  return lowered.includes('<tt') || lowered.includes('http://www.w3.org/ns/ttml');
}

export function isLineSyncedLrc(lyrics: string): boolean {
  if (isQrc(normalizeLyricsText(lyrics))) return true;
  return lyrics.split('\n').some((line) => {
    const trimmed = line.trim();
    return LINE_RE.test(trimmed) || YRC_LINE_RE.test(trimmed);
  });
}

function hasEnhancedWordTimings(line: string): boolean {
  const match = LINE_RE.exec(line.trim());
  if (!match) return false;
  const content = match[3];
  ENHANCED_WORD_TIME_RE.lastIndex = 0;
  const timings = [...content.matchAll(ENHANCED_WORD_TIME_RE)];
  for (let index = 0; index < timings.length; index++) {
    const timing = timings[index];
    const textStart = (timing.index ?? 0) + timing[0].length;
    const textEnd = index + 1 < timings.length ? (timings[index + 1].index ?? content.length) : content.length;
    if (textStart < textEnd && content.slice(textStart, textEnd)) return true;
  }
  return false;
}

export function hasWordSyncedLyrics(lyrics: string): boolean {
  const normalized = normalizeLyricsText(lyrics);
  if (isQrc(normalized)) return qrcHasWordTimings(normalized);
  if (isTtml(normalized)) {
    return [...normalized.matchAll(TTML_SPAN_RE)].some(
      (m) => TTML_BEGIN_ATTR_RE.test(m[0]) && TTML_END_ATTR_RE.test(m[0]),
    );
  }
  return normalized.split('\n').some((line) => hasEnhancedWordTimings(line));
}

export function displayLyricsText(lyrics: string): string {
  const raw = normalizeLyricsText(lyrics);
  if (!raw || raw === LYRICS_NOT_FOUND) return '';
  let visible: string[];
  if (isTtml(raw)) {
    try {
      visible = parseTtmlLines(raw).map((line) => line.text);
    } catch {
      visible = [];
    }
  } else if (isLineSyncedLrc(raw)) {
    try {
      visible = parseSyncedEntries(raw).map((entry) => entry.text);
    } catch {
      visible = [];
    }
  } else if (raw.startsWith('<')) {
    visible = [];
  } else {
    visible = raw.split('\n').map((line) => cleanInlineWordTimingText(line));
  }
  return visible
    .map((line) => line.replace(WHITESPACE_RE, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export function hasMeaningfulLyricsContent(lyrics: string): boolean {
  return Boolean(displayLyricsText(lyrics));
}

export function lyricsOrNotFound(lyrics: string): string | null {
  const normalized = normalizeLyricsText(lyrics);
  return hasMeaningfulLyricsContent(normalized) ? normalized : null;
}

export function parseLyrics(rawText: string | null | undefined, durationSeconds?: number | null): ParsedLyrics {
  if (typeof rawText !== 'string') return { synced: null, unsynced: null, quality: 0 };
  const normalized = normalizeLyricsText(rawText);
  if (!hasMeaningfulLyricsContent(normalized)) return { synced: null, unsynced: null, quality: 0 };

  if (isTtml(normalized)) {
    const entries = parseTtmlLines(normalized);
    if (!entries.length) return { synced: null, unsynced: null, quality: 0 };
    const lines = finalizeLines(entries.map(entryToLine), durationSeconds);
    const quality: 0 | 1 | 2 = lines.some((line) => line.words?.length) ? 2 : 1;
    return { synced: lines, unsynced: joinedText(lines), quality };
  }

  if (isLineSyncedLrc(normalized)) {
    const entries = parseSyncedEntries(normalized);
    if (!entries.length) return { synced: null, unsynced: null, quality: 0 };
    const lines = finalizeLines(entries.map(entryToLine), durationSeconds);
    const quality: 0 | 1 | 2 = lines.some((line) => line.words?.length) ? 2 : 1;
    return { synced: lines, unsynced: joinedText(lines), quality };
  }

  if (normalized.startsWith('<')) return { synced: null, unsynced: null, quality: 0 };
  const unsynced = displayLyricsText(normalized);
  if (!unsynced) return { synced: null, unsynced: null, quality: 0 };
  return { synced: null, unsynced, quality: 0 };
}

function joinedText(lines: LyricLine[]): string | null {
  const text = lines.map((line) => line.text).filter((t) => t.trim()).join('\n');
  return text || null;
}

function finalizeLines(lines: LyricLine[], durationSeconds?: number | null): LyricLine[] {
  const sorted = [...lines].sort((a, b) => a.timeMs - b.timeMs);
  for (let index = 0; index < sorted.length; index++) {
    const line = sorted[index];
    const following = sorted[index + 1];
    if ((line.endTimeMs ?? 0) <= line.timeMs) {
      line.endTimeMs = following ? following.timeMs : line.timeMs + 4000;
    }
  }
  let result = sorted;
  if (durationSeconds) {
    result = insertInstrumentalBreaks(result, durationSeconds * 1000);
    result = [...result].sort((a, b) => a.timeMs - b.timeMs);
  }
  return result;
}

function parseTtmlLines(normalized: string): ParsedEntry[] {
  const parsed: TtmlLine[] = parseTtml(normalized);
  const entries: ParsedEntry[] = parsed.map((line) => ({
    time: Math.round(line.start * 1000),
    endMs: Math.round(line.end * 1000),
    text: line.text,
    words:
      line.words
        .filter((w) => w.text)
        .map((w) => ({ text: w.text, start: w.start, end: w.end, isBackground: w.isBackground })) || null,
    agent: line.agent,
    romanizedText: line.providerRomanizedText,
    romanizedWords: line.providerRomanizedWords,
    romanizedLanguage: line.providerRomanizedLanguage,
    translation: line.providerTranslationText ?? undefined,
  }));
  entries.sort((a, b) => a.time - b.time);
  return entries;
}

function parseSyncedEntries(normalized: string): ParsedEntry[] {
  if (isQrc(normalized)) {
    return parseQrc(normalized).map((line) => ({
      time: Math.round(line.start * 1000),
      text: line.text,
      words: line.words.map((w) => ({ text: w.text, start: w.start, end: w.end, isBackground: false })),
      agent: line.agent,
      durationMs: Math.max(0, Math.round((line.end - line.start) * 1000)),
    }));
  }

  const lines = normalized.split('\n');
  const result: ParsedEntry[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineStartMs = firstLineTimestampMs(line);
    const nextLineStartMs = findNextLineStartMs(lines, index, lineStartMs);
    let entries = parseEnhancedLrcLine(line, nextLineStartMs);
    if (entries == null) entries = parseLineSyncedLrcLine(line);
    if (entries == null) entries = parseMillisecondsSyncedLine(line);
    if (entries != null) result.push(...entries);
  }
  return mergeLineSyncedTranslations(result);
}

function parseLineSyncedLrcLine(line: string): ParsedEntry[] | null {
  if (!line) return null;
  const match = LINE_RE.exec(line.trim());
  if (!match) return null;
  const times = match[1];
  const text = cleanInlineWordTimingText(match[3]);
  const entries: ParsedEntry[] = [];
  TIME_RE.lastIndex = 0;
  let tm: RegExpExecArray | null;
  while ((tm = TIME_RE.exec(times))) {
    const timeMs = lrcTimestampMs(tm);
    if (timeMs == null) continue;
    entries.push({ time: timeMs, text });
  }
  return entries.length ? entries : null;
}

function parseEnhancedLrcLine(line: string, nextLineStartMs: number | null): ParsedEntry[] | null {
  const match = LINE_RE.exec(line.trim());
  if (!match) return null;
  const rawContent = match[3];
  ENHANCED_WORD_TIME_RE.lastIndex = 0;
  const timingMatches = [...rawContent.matchAll(ENHANCED_WORD_TIME_RE)];
  if (!timingMatches.length) return null;

  const rawWords: { text: string; startMs: number; endMs: number | null }[] = [];
  for (let index = 0; index < timingMatches.length; index++) {
    const timingMatch = timingMatches[index];
    const textStart = (timingMatch.index ?? 0) + timingMatch[0].length;
    const textEnd =
      index + 1 < timingMatches.length ? (timingMatches[index + 1].index ?? rawContent.length) : rawContent.length;
    let text = rawContent.slice(textStart, textEnd);
    if (index === 0 && (timingMatch.index ?? 0) > 0) text = rawContent.slice(0, timingMatch.index ?? 0) + text;
    if (!text) continue;
    const startMs = lrcTimestampMs(timingMatch);
    if (startMs == null) continue;
    let endMs: number | null = null;
    if (index + 1 < timingMatches.length) endMs = lrcTimestampMs(timingMatches[index + 1]);
    if (!text.trim() && rawWords.length) {
      rawWords[rawWords.length - 1] = { ...rawWords[rawWords.length - 1], text: rawWords[rawWords.length - 1].text + text };
    } else {
      rawWords.push({ text, startMs, endMs });
    }
  }
  if (!rawWords.length) return null;

  TIME_RE.lastIndex = 0;
  const lineStartTimes: number[] = [];
  let tm: RegExpExecArray | null;
  while ((tm = TIME_RE.exec(match[1]))) {
    const ms = lrcTimestampMs(tm);
    if (ms != null) lineStartTimes.push(ms);
  }
  if (!lineStartTimes.length) return null;
  const baseLineStartMs = lineStartTimes[0];
  const visibleText = cleanInlineWordTimingText(rawContent);
  if (!visibleText) return null;

  const entries: ParsedEntry[] = [];
  for (let index = 0; index < lineStartTimes.length; index++) {
    const lineStartMs = lineStartTimes[index];
    const offsetMs = lineStartMs - baseLineStartMs;
    const followingLineStartMs =
      index + 1 < lineStartTimes.length ? lineStartTimes[index + 1] : nextLineStartMs;
    const words: EntryWord[] = rawWords.map((rawWord) => {
      const wordStartMs = Math.max(0, rawWord.startMs + offsetMs);
      let wordEndMs: number;
      if (rawWord.endMs != null) wordEndMs = rawWord.endMs + offsetMs;
      else if (followingLineStartMs != null) wordEndMs = followingLineStartMs;
      else wordEndMs = wordStartMs + DEFAULT_ENHANCED_WORD_DURATION_MS;
      wordEndMs = Math.max(wordEndMs, wordStartMs + 1);
      return { text: rawWord.text, start: wordStartMs / 1000, end: wordEndMs / 1000, isBackground: false };
    });
    const lineEndMs = Math.max(...words.map((w) => Math.round(w.end * 1000)));
    entries.push({
      time: lineStartMs,
      text: visibleText,
      words,
      durationMs: Math.max(1, lineEndMs - lineStartMs),
    });
  }
  return entries;
}

function parseMillisecondsSyncedLine(line: string): ParsedEntry[] | null {
  if (!line) return null;
  const match = YRC_LINE_RE.exec(line.trim());
  if (!match) return null;
  const timeMs = Number.parseInt(match[1], 10);
  if (Number.isNaN(timeMs)) return null;
  const text = cleanInlineWordTimingText(match[2]);
  return [{ time: timeMs, text }];
}

function mergeLineSyncedTranslations(entries: ParsedEntry[]): ParsedEntry[] {
  const merged = new Map<number, ParsedEntry>();
  for (const entry of entries) {
    const existing = merged.get(entry.time);
    if (!existing) {
      merged.set(entry.time, entry);
      continue;
    }
    if (!existing.text.trim() && entry.text.trim()) {
      merged.set(entry.time, { ...entry, translation: existing.translation ?? entry.translation });
      continue;
    }
    if (!entry.text.trim()) continue;
    const translated = entry.text.replace(WHITESPACE_RE, ' ').trim();
    if (
      translated &&
      translated.toLowerCase() !== existing.text.trim().toLowerCase() &&
      existing.translation == null
    ) {
      merged.set(entry.time, { ...existing, translation: translated });
    }
  }
  return [...merged.values()];
}

function firstLineTimestampMs(line: string): number | null {
  const match = LINE_RE.exec(line.trim());
  if (!match) return null;
  TIME_RE.lastIndex = 0;
  const first = TIME_RE.exec(match[1]);
  return first ? lrcTimestampMs(first) : null;
}

function findNextLineStartMs(lines: string[], currentIndex: number, currentLineStartMs: number | null): number | null {
  for (let index = currentIndex + 1; index < lines.length; index++) {
    const candidate = firstLineTimestampMs(lines[index]);
    if (candidate == null) continue;
    if (currentLineStartMs == null || candidate > currentLineStartMs) return candidate;
  }
  return null;
}

function lrcTimestampMs(match: RegExpExecArray): number | null {
  const minutes = Number.parseInt(match[1], 10);
  const seconds = Number.parseInt(match[2], 10);
  if (Number.isNaN(minutes) || Number.isNaN(seconds)) return null;
  if (seconds < 0 || seconds > 59) return null;
  const fraction = match[3] ?? '';
  let milliseconds = 0;
  if (fraction.length === 0) milliseconds = 0;
  else if (fraction.length === 1) milliseconds = Number.parseInt(fraction, 10) * 100;
  else if (fraction.length === 2) milliseconds = Number.parseInt(fraction, 10) * 10;
  else if (fraction.length === 3) milliseconds = Number.parseInt(fraction, 10);
  else return null;
  return minutes * 60000 + seconds * 1000 + milliseconds;
}

function cleanInlineWordTimingText(text: string): string {
  const cleaned = text
    .replace(ENHANCED_WORD_TIME_RE, '')
    .replace(INLINE_MS_TIME_RE, '')
    .replace(YRC_WORD_TIME_RE, '');
  return cleaned.replace(WHITESPACE_RE, ' ').trim();
}

export function insertInstrumentalBreaks(entries: LyricLine[], songDurationMs = 0): LyricLine[] {
  if (!entries.length) return entries;
  const result: LyricLine[] = [];
  const firstVocal = entries.find((e) => e.timeMs >= 0 && e.text.trim());
  if (firstVocal) {
    const introGapMs = firstVocal.timeMs - INSTRUMENTAL_INTRO_START_MS;
    if (introGapMs >= INSTRUMENTAL_GAP_THRESHOLD_MS) {
      result.push({
        timeMs: INSTRUMENTAL_INTRO_START_MS,
        endTimeMs: firstVocal.timeMs,
        text: '',
        isInstrumental: true,
        durationMs: introGapMs,
      });
    }
  }
  result.push(...entries);
  if (songDurationMs > 0) {
    const lastVocal = [...entries].reverse().find((e) => e.text.trim());
    if (lastVocal) {
      const outroStartMs = lastVocal.timeMs + INSTRUMENTAL_OUTRO_VOCAL_TAIL_MS;
      const outroDurationMs = songDurationMs - outroStartMs;
      if (outroDurationMs >= INSTRUMENTAL_GAP_THRESHOLD_MS) {
        result.push({
          timeMs: outroStartMs,
          endTimeMs: songDurationMs,
          text: '',
          isInstrumental: true,
          durationMs: outroDurationMs,
        });
      }
    }
  }
  return result;
}

function entryToLine(entry: ParsedEntry): LyricLine {
  const timeMs = Math.trunc(entry.time);
  const line: LyricLine = { timeMs, endTimeMs: timeMs, text: entry.text };
  const durationMs = entry.durationMs;
  if (durationMs) {
    line.endTimeMs = timeMs + Math.trunc(durationMs);
    line.durationMs = Math.trunc(durationMs);
  } else if (entry.endMs != null) {
    line.endTimeMs = Math.trunc(entry.endMs);
  }
  const words = entry.words;
  if (words?.length) {
    const mapped: LyricWord[] = words.map((word) => ({
      text: word.text,
      startMs: Math.max(0, Math.round(word.start * 1000)),
      endMs: Math.max(0, Math.round(word.end * 1000)),
      isBackground: Boolean(word.isBackground),
    }));
    for (let index = 0; index < mapped.length; index++) {
      const word = mapped[index];
      if (word.endMs <= word.startMs) {
        const following = mapped[index + 1];
        word.endMs = following ? following.startMs : word.startMs + 1000;
        if (word.endMs <= word.startMs) word.endMs = word.startMs + 1;
      }
    }
    line.words = mapped;
    if (!durationMs) line.endTimeMs = Math.max(...mapped.map((w) => w.endMs));
  }
  if (entry.agent) line.agent = entry.agent;
  if (entry.translation) {
    const cleaned = entry.translation.replace(WHITESPACE_RE, ' ').trim();
    if (cleaned && cleaned.toLowerCase() !== entry.text.trim().toLowerCase()) line.translation = cleaned;
  }
  const romanized = providedRomanization(entry);
  if (romanized != null) {
    line.romanizedText = romanized;
    const romanizedWords = entry.romanizedWords;
    if (romanizedWords && words && romanizedWords.length === words.length) {
      line.romanizedWords = romanizedWords.map((w) => w.replace(WHITESPACE_RE, ' ').trim());
    }
  }
  if (entry.isInstrumental) line.isInstrumental = true;
  return line;
}

function providedRomanization(entry: ParsedEntry): string | null {
  const original = entry.text;
  if (!original.trim()) return null;
  const romanized = entry.romanizedText;
  if (romanized == null) return null;
  const normalized = romanized.replace(WHITESPACE_RE, ' ').trim();
  if (!normalized || normalized.toLowerCase() === original.trim().toLowerCase()) return null;
  const language = (entry.romanizedLanguage ?? '').split('-')[0].split('_')[0].toLowerCase();
  if (language.startsWith('ar')) return null;
  return normalized;
}

/** Quality of a server-shaped lyrics payload, for the client-upgrade rule. */
export function inferLyricsQuality(synced: LyricLine[] | null | undefined, unsynced: string | null | undefined): number {
  if (Array.isArray(synced) && synced.length) {
    return synced.some((line) => line.words?.length) ? 2 : 1;
  }
  if (typeof unsynced === 'string' && unsynced.trim()) return 0;
  return -1;
}
