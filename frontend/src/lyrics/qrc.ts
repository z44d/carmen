/**
 * QRC lyric parsing — a TypeScript port of `server/lyrics/_qrc.py`
 * (itself a port of the Android `QRCParser`).
 *
 * QRC lines look like `[startMs,durationMs]word(start,dur)word(start,dur)`.
 * A document may also arrive wrapped in XML carrying a
 * `LyricContent="..."` attribute; the lyric text is extracted from that
 * attribute first. No romanization is generated here.
 */
const LINE_TIMING_RE = /^\[(\d{1,8}),(\d{1,8})\](.*)$/;
const WORD_TIMING_RE = /(.*?)\((\d{1,8}),(\d{1,8})(?:,\d{1,8})?\)/g;
const METADATA_RE = /^\[([A-Za-z]+):(.*)\]$/;
const LYRIC_CONTENT_ATTR_RE = /LyricContent\s*=\s*"/i;

const METADATA_PREFIXES = new Set([
  '词', '作词', '曲', '作曲', '编曲', '和声', '混音', '吉他', '制作人', '演唱', '原唱',
  '翻唱', '后期', '和音', '录音', '策划', '伴奏', '美工', '海报', '旁白',
  'writtenby', 'producedby', 'composedby', 'arrangedby', 'mixing', 'mastering',
  'vocal', 'vocals', 'guitar', 'bass', 'drums', 'producer', 'lyricist',
  'composer', 'arranger', 'lyricsby',
]);

export interface QrcWord {
  text: string;
  start: number;
  end: number;
}

export interface QrcLine {
  text: string;
  start: number;
  end: number;
  words: QrcWord[];
  agent: string | null;
}

function extractLyricContent(content: string): string {
  const match = LYRIC_CONTENT_ATTR_RE.exec(content);
  if (!match) return content;
  const valueStart = match.index + match[0].length;
  const valueEnd = content.indexOf('"', valueStart);
  if (valueEnd < 0) return content;
  return unescapeXml(content.slice(valueStart, valueEnd));
}

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function isQrc(content: string): boolean {
  const lowered = content.toLowerCase();
  if (lowered.includes('<qrcinfos') || lowered.includes('lyriccontent=')) return true;
  return content.split('\n').some((line) => {
    const trimmed = line.trim();
    const m = LINE_TIMING_RE.exec(trimmed);
    if (!m) return false;
    WORD_TIMING_RE.lastIndex = 0;
    return WORD_TIMING_RE.test(m[3]);
  });
}

export function qrcHasWordTimings(content: string): boolean {
  return extractLyricContent(content).split('\n').some((line) => {
    const trimmed = line.trim();
    const m = LINE_TIMING_RE.exec(trimmed);
    if (!m) return false;
    WORD_TIMING_RE.lastIndex = 0;
    return WORD_TIMING_RE.test(m[3]);
  });
}

interface MutableLine {
  text: string;
  startMs: number;
  durationMs: number;
  words: { text: string; startMs: number; durationMs: number }[];
  agent: string | null;
}

function normalizeForComparison(value: string | null | undefined): string {
  if (!value) return '';
  return [...value].filter((ch) => /[A-Za-z0-9]/u.test(ch) || /\p{L}/u.test(ch) || /\p{N}/u.test(ch)).join('').toLowerCase();
}

function isMetadataPrefix(value: string): boolean {
  const normalized = normalizeForComparison(value);
  return (
    METADATA_PREFIXES.has(normalized) ||
    normalized.endsWith('词') ||
    normalized.endsWith('曲') ||
    normalized.endsWith('声') ||
    normalized.endsWith('音')
  );
}

function isMetadataLine(
  line: MutableLine,
  title: string | null,
  artist: string | null,
): boolean {
  const normalizedText = normalizeForComparison(line.text);
  const normalizedTitle = title ? normalizeForComparison(title) : '';
  const normalizedArtist = artist ? normalizeForComparison(artist) : '';
  if (
    normalizedTitle &&
    normalizedText.includes(normalizedTitle) &&
    (!normalizedArtist || normalizedText.includes(normalizedArtist))
  ) {
    return true;
  }
  if (normalizedArtist && normalizedText === normalizedArtist) return true;
  const words = line.words;
  return (
    words.length > 2 &&
    words.every((w) => Math.abs(w.durationMs - words[0].durationMs) < 10)
  );
}

function removeCharacterPrefix(
  words: MutableLine['words'],
  characterCount: number,
): MutableLine['words'] {
  let remaining = characterCount;
  const retained: MutableLine['words'] = [];
  for (const word of words) {
    if (remaining >= word.text.length) {
      remaining -= word.text.length;
    } else if (remaining > 0) {
      const retainedText = word.text.slice(remaining).trimStart();
      remaining = 0;
      if (retainedText) retained.push({ ...word, text: retainedText });
    } else {
      retained.push(word);
    }
  }
  while (retained.length && !retained[0].text.trim()) retained.shift();
  if (retained.length) retained[0] = { ...retained[0], text: retained[0].text.trimStart() };
  return retained;
}

function extractSinger(
  line: MutableLine,
  aliases: Map<string, string>,
  nextVoiceId: { value: number },
  currentSinger: string | null,
  isFirstFew: boolean,
  title: string | null,
  artist: string | null,
): { kept: boolean; singer: string | null } {
  if (isFirstFew && isMetadataLine(line, title, artist)) {
    return { kept: false, singer: currentSinger };
  }
  const text = line.text;
  let colonIndex = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ':' || text[i] === '：') {
      colonIndex = i;
      break;
    }
  }
  if (colonIndex < 0) {
    line.agent = currentSinger;
    return { kept: true, singer: currentSinger };
  }
  const singerName = text.slice(0, colonIndex).trim();
  if (isMetadataPrefix(singerName)) return { kept: false, singer: currentSinger };
  if (!singerName || singerName.length > 30) {
    line.agent = currentSinger;
    return { kept: true, singer: currentSinger };
  }
  let agent: string;
  if (aliases.has(singerName)) {
    agent = aliases.get(singerName)!;
  } else {
    const normalized = singerName.toUpperCase();
    if (normalized === '合' || normalized === 'ALL' || normalized === '合唱') {
      agent = 'v1000';
    } else {
      agent = `v${nextVoiceId.value}`;
      nextVoiceId.value += 1;
    }
    aliases.set(singerName, agent);
  }
  const singer = agent;
  line.words = removeCharacterPrefix(line.words, colonIndex + 1);
  line.text = line.words.map((w) => w.text).join('').trim();
  if (!line.text || !line.words.length) return { kept: false, singer };
  line.agent = agent;
  const firstWord = line.words[0];
  const lastWord = line.words[line.words.length - 1];
  line.startMs = firstWord.startMs;
  line.durationMs = Math.max(0, lastWord.startMs + lastWord.durationMs - firstWord.startMs);
  return { kept: true, singer };
}

function readMetadata(content: string): { title: string | null; artist: string | null } {
  let title: string | null = null;
  let artist: string | null = null;
  for (const line of content.split('\n')) {
    const m = METADATA_RE.exec(line.trim());
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'ti') title = value || null;
    else if (key === 'ar') artist = value || null;
  }
  return { title, artist };
}

export function parseQrc(content: string): QrcLine[] {
  const lyricContent = extractLyricContent(content);
  const { title, artist } = readMetadata(lyricContent);
  const aliases = new Map<string, string>();
  const nextVoiceId = { value: 1 };
  let currentSinger: string | null = null;
  const parsed: MutableLine[] = [];

  for (const rawLine of lyricContent.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed || METADATA_RE.test(trimmed)) continue;
    const match = LINE_TIMING_RE.exec(trimmed);
    if (!match) continue;
    const words: MutableLine['words'] = [];
    WORD_TIMING_RE.lastIndex = 0;
    let wm: RegExpExecArray | null;
    while ((wm = WORD_TIMING_RE.exec(match[3]))) {
      words.push({ text: wm[1], startMs: Number(wm[2]), durationMs: Number(wm[3]) });
    }
    const keptWords = words.filter((w) => w.text);
    if (!keptWords.length) continue;
    const line: MutableLine = {
      text: keptWords.map((w) => w.text).join(''),
      startMs: Number(match[1]),
      durationMs: Number(match[2]),
      words: keptWords,
      agent: null,
    };
    const { kept, singer } = extractSinger(
      line,
      aliases,
      nextVoiceId,
      currentSinger,
      parsed.length < 5,
      title,
      artist,
    );
    currentSinger = singer;
    if (kept) parsed.push(line);
  }

  const out: QrcLine[] = [];
  for (let index = 0; index < parsed.length; index++) {
    const line = parsed[index];
    const nextStart = index + 1 < parsed.length ? parsed[index + 1].startMs : null;
    const lastWord = line.words[line.words.length - 1];
    const fallbackEnd =
      lastWord != null
        ? lastWord.startMs + lastWord.durationMs
        : nextStart != null
          ? nextStart
          : line.startMs;
    let lineEndMs: number;
    if (line.durationMs > 0) lineEndMs = line.startMs + line.durationMs;
    else if (nextStart != null) lineEndMs = nextStart;
    else lineEndMs = fallbackEnd;
    lineEndMs = Math.max(lineEndMs, line.startMs);
    const parsedWords: QrcWord[] = [];
    for (let wi = 0; wi < line.words.length; wi++) {
      const word = line.words[wi];
      const nextWordStart = wi + 1 < line.words.length ? line.words[wi + 1].startMs : null;
      let wordEnd: number;
      if (word.durationMs > 0) wordEnd = word.startMs + word.durationMs;
      else if (nextWordStart != null) wordEnd = nextWordStart;
      else wordEnd = lineEndMs;
      wordEnd = Math.max(wordEnd, word.startMs);
      parsedWords.push({ text: word.text, start: word.startMs / 1000, end: wordEnd / 1000 });
    }
    out.push({
      text: line.text.trim(),
      start: line.startMs / 1000,
      end: lineEndMs / 1000,
      words: parsedWords,
      agent: line.agent,
    });
  }
  return out;
}
