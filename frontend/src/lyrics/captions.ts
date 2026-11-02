/**
 * Caption-track parsers for the YouTube Subtitle provider.
 *
 * YouTube serves caption tracks as JSON3 (`fmt=json3`) or WebVTT
 * (`fmt=vtt`) from the `baseUrl` in the player response's
 * `captionTracks`. Both are parsed into plain timed lines, then
 * serialised to LRC so the shared chain parser (`parse.ts`) handles
 * them like every other provider's line-synced lyrics.
 *
 * JSON3 shape: `{events: [{tStartMs, dDurationMs, segs: [{utf8}]}]}`.
 * Events without segments (or with only whitespace) are skipped;
 * `segs` text is concatenated in order. A `wWinId`/`aAppend`
 * continuation is just another event — concatenation across events
 * is NOT merged, so each event stays its own line.
 *
 * WebVTT shape: `HH:MM:SS.mmm --> HH:MM:SS.mmm` cue headers, cue
 * text on the following lines until a blank line. HTML-style tags
 * (`<c.color>`, `<00:00:01.000>`, …) are stripped from cue text.
 */

export interface CaptionLine {
  /** Start time in milliseconds. */
  timeMs: number;
  /** End time in milliseconds, when the format carries it. */
  endMs?: number;
  text: string;
}

function formatLrcTime(timeMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, timeMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hundredths = Math.floor((Math.max(0, timeMs) % 1000) / 10);
  return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}]`;
}

/** Timed caption lines serialised as LRC (`[mm:ss.cc]text` per line). */
export function captionsToLrc(lines: CaptionLine[]): string | null {
  const rendered = lines
    .filter((line) => line.text.trim())
    .map((line) => `${formatLrcTime(line.timeMs)}${line.text.trim()}`);
  return rendered.length ? rendered.join('\n') : null;
}

/** Parse a JSON3 caption payload (`fmt=json3`). */
export function parseJson3Captions(payload: unknown): CaptionLine[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return [];
  const events = (payload as Record<string, unknown>).events;
  if (!Array.isArray(events)) return [];
  const lines: CaptionLine[] = [];
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue;
    const record = event as Record<string, unknown>;
    const startMs = Number(record.tStartMs ?? NaN);
    if (!Number.isFinite(startMs)) continue;
    const segs = record.segs;
    if (!Array.isArray(segs)) continue;
    const text = segs
      .filter((seg): seg is Record<string, unknown> => typeof seg === 'object' && seg !== null)
      .map((seg) => String(seg.utf8 ?? ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const durationMs = Number(record.dDurationMs ?? NaN);
    lines.push({
      timeMs: Math.max(0, Math.trunc(startMs)),
      ...(Number.isFinite(durationMs) ? { endMs: Math.max(0, Math.trunc(startMs + durationMs)) } : {}),
      text,
    });
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

const VTT_TIME_RE = /^(\d{2,}):(\d{2}):(\d{2})[.,](\d{3})$/;
const VTT_CUE_RE = /^(\d{2,}:\d{2}:\d{2}[.,]\d{3})\s+-->\s+(\d{2,}:\d{2}:\d{2}[.,]\d{3})/;
const VTT_TAG_RE = /<[^>]*>/g;

function parseVttTime(value: string): number | null {
  const match = VTT_TIME_RE.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4]);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}

/** Parse a WebVTT caption payload (`fmt=vtt`). */
export function parseWebVtt(vtt: string): CaptionLine[] {
  const lines: CaptionLine[] = [];
  const rawLines = vtt.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let current: { start: number; end: number; text: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const text = current.text
      .join(' ')
      .replace(VTT_TAG_RE, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) lines.push({ timeMs: current.start, endMs: current.end, text });
    current = null;
  };
  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    const cue = VTT_CUE_RE.exec(line);
    if (cue) {
      flush();
      const start = parseVttTime(cue[1]);
      const end = parseVttTime(cue[2]);
      if (start == null || end == null) continue;
      current = { start, end, text: [] };
      continue;
    }
    if (!line) {
      flush();
      continue;
    }
    if (line === 'WEBVTT' || line.startsWith('Kind:') || line.startsWith('Language:')) continue;
    if (current) current.text.push(line);
  }
  flush();
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}
