/**
 * TTML parsing — a TypeScript port of `server/lyrics/_ttml.py`
 * (itself a port of the Android `TTMLParser`).
 *
 * Safe XML only: any DOCTYPE/ENTITY declaration is rejected before
 * parsing. Namespace handling is by local name. Times are seconds
 * (floats) in the returned line dicts, as in Python.
 *
 * The XML tree is built by a small hand-written parser (no DOMParser
 * dependency, so it runs identically in the browser and in vitest's
 * Node environment).
 */
const MILLIS_PER_SECOND = 1000;
const DEFAULT_FINAL_LINE_DURATION_MS = 4000;
const WHITESPACE_RE = /\s+/g;
const OFFSET_TIME_RE = /^([0-9]+(?:\.[0-9]+)?)(ms|h|m|s|f|t)$/i;
const UNSAFE_XML_RE = /<!\s*(?:DOCTYPE|ENTITY)\b/i;
const SUPPLEMENTARY_ROLES = new Set(['x-bg', 'x-translation', 'x-roman']);

export interface TtmlWord {
  text: string;
  start: number;
  end: number;
  isBackground: boolean;
}

export interface TtmlLine {
  text: string;
  start: number;
  end: number;
  words: TtmlWord[];
  agent: string | null;
  providerRomanizedText: string | null;
  providerRomanizedWords: string[] | null;
  providerRomanizedLanguage: string | null;
  providerTranslationText: string | null;
}

// ── Minimal XML tree ───────────────────────────────────────────────────────

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: (XmlNode | string)[];
  parent: XmlNode | null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function parseXml(source: string): XmlNode {
  // Strip a leading BOM / XML declaration / comments / processing
  // instructions before the root element.
  let text = source.replace(/^\uFEFF/, '');
  const rootStack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let i = 0;
  const pushText = (value: string) => {
    if (!value) return;
    const top = rootStack[rootStack.length - 1];
    if (top) top.children.push(decodeEntities(value));
  };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      pushText(text.slice(i));
      break;
    }
    if (lt > i) pushText(text.slice(i, lt));
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) throw new Error('unterminated comment');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) throw new Error('unterminated CDATA');
      pushText(text.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) throw new Error('unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt + 2);
      if (end < 0) throw new Error('unterminated declaration');
      i = end + 1;
      continue;
    }
    const gt = text.indexOf('>', lt);
    if (gt < 0) throw new Error('unterminated tag');
    const inside = text.slice(lt + 1, gt);
    if (inside.startsWith('/')) {
      const name = inside.slice(1).trim();
      const top = rootStack.pop();
      if (!top || localName(top.tag) !== localName(name)) throw new Error('mismatched close tag');
      i = gt + 1;
      continue;
    }
    const selfClosing = inside.trimEnd().endsWith('/');
    const body = selfClosing ? inside.trimEnd().slice(0, -1) : inside;
    const spaceAt = body.search(/\s/);
    const tag = spaceAt < 0 ? body.trim() : body.slice(0, spaceAt);
    const node: XmlNode = {
      tag,
      attrs: parseAttributes(spaceAt < 0 ? '' : body.slice(spaceAt)),
      children: [],
      parent: rootStack[rootStack.length - 1] ?? null,
    };
    if (node.parent) node.parent.children.push(node);
    else if (!root) root = node;
    else throw new Error('multiple root elements');
    if (!selfClosing) rootStack.push(node);
    i = gt + 1;
  }
  if (rootStack.length || !root) throw new Error('malformed XML');
  return root;
}

function localName(tag: string): string {
  if (tag.startsWith('{')) return tag.split('}', 2)[1] ?? tag;
  const colon = tag.indexOf(':');
  return colon >= 0 ? tag.slice(colon + 1) : tag;
}

function attrOf(element: XmlNode | null, name: string): string | null {
  if (!element) return null;
  for (const [key, value] of Object.entries(element.attrs)) {
    if (localName(key).toLowerCase() === name.toLowerCase()) {
      const trimmed = value.trim();
      return trimmed || null;
    }
  }
  return null;
}

function inheritedAttr(element: XmlNode, name: string): string | null {
  let current: XmlNode | null = element;
  while (current) {
    const value = attrOf(current, name);
    if (value != null) return value;
    current = current.parent;
  }
  return null;
}

function hasLocalName(element: XmlNode, expected: string): boolean {
  return localName(element.tag).toLowerCase() === expected.toLowerCase();
}

function descendants(element: XmlNode): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (node: XmlNode) => {
    for (const child of node.children) {
      if (typeof child !== 'string') {
        out.push(child);
        walk(child);
      }
    }
  };
  walk(element);
  return out;
}

function directChildren(element: XmlNode): XmlNode[] {
  return element.children.filter((c): c is XmlNode => typeof c !== 'string');
}

function directText(element: XmlNode): string {
  let out = '';
  // Direct text = element.text plus each child's tail. In this tree,
  // tails are plain string children interleaved after each element.
  for (const child of element.children) {
    if (typeof child === 'string') out += child;
  }
  // The loop above also counts nested elements' text, which ElementTree
  // does not. Recompute: only strings that are direct children count,
  // but strings after a nested span are tails — in our tree every
  // string child IS a direct text/tail chunk, while nested text lives
  // inside the nested node, so the sum above is exactly direct text.
  return out;
}

function iterText(element: XmlNode): string {
  let out = '';
  for (const child of element.children) {
    out += typeof child === 'string' ? child : iterText(child);
  }
  return out;
}

function childNodes(element: XmlNode): (XmlNode | string)[] {
  return element.children;
}

// ── Timing ─────────────────────────────────────────────────────────────────

interface Timing {
  tickRate: number;
  frameRate: number;
}

function readTimingContext(root: XmlNode): Timing {
  const baseRaw = attrOf(root, 'frameRate');
  let baseRate = baseRaw != null ? Number(baseRaw) : NaN;
  if (!Number.isFinite(baseRate) || baseRate <= 0) baseRate = 30;
  let multiplier = 1;
  const multRaw = attrOf(root, 'frameRateMultiplier');
  if (multRaw) {
    const nums = multRaw.split(/\s+/).map(Number);
    if (nums.length === 2 && nums[0] > 0 && nums[1] > 0) multiplier = nums[0] / nums[1];
  }
  const frameRate = Math.max(baseRate * multiplier, 1);
  const tickRaw = attrOf(root, 'tickRate');
  let tickRate = tickRaw != null ? Number(tickRaw) : NaN;
  if (!Number.isFinite(tickRate) || tickRate <= 0) tickRate = frameRate;
  return { tickRate, frameRate };
}

function toMs(seconds: number): number | null {
  const ms = seconds * 1000;
  if (ms < 0 || Number.isNaN(ms) || !Number.isFinite(ms)) return null;
  return Math.round(ms);
}

function parseTime(rawValue: string, context: Timing): number | null {
  const value = rawValue.trim();
  if (!value) return null;
  const offset = OFFSET_TIME_RE.exec(value);
  if (offset) {
    const amount = Number(offset[1]);
    if (!Number.isFinite(amount) || amount < 0) return null;
    const unit = offset[2].toLowerCase();
    let seconds: number;
    if (unit === 'h') seconds = amount * 3600;
    else if (unit === 'm') seconds = amount * 60;
    else if (unit === 's') seconds = amount;
    else if (unit === 'ms') seconds = amount / 1000;
    else if (unit === 'f') seconds = amount / context.frameRate;
    else if (unit === 't') seconds = amount / context.tickRate;
    else return null;
    return toMs(seconds);
  }
  const parts = value.replace(/;/g, ':').split(':');
  if (![1, 2, 3, 4].includes(parts.length)) return null;
  const numeric: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isFinite(n) || n < 0) return null;
    numeric.push(n);
  }
  if (numeric.length >= 2) {
    const check = numeric.slice(1, numeric.length - (numeric.length === 4 ? 1 : 0));
    if (check.some((v) => v >= 60)) return null;
  }
  let seconds: number;
  if (numeric.length === 1) seconds = numeric[0];
  else if (numeric.length === 2) seconds = numeric[0] * 60 + numeric[1];
  else if (numeric.length === 3) seconds = numeric[0] * 3600 + numeric[1] * 60 + numeric[2];
  else seconds = numeric[0] * 3600 + numeric[1] * 60 + numeric[2] + numeric[3] / context.frameRate;
  return toMs(seconds);
}

function attrTime(element: XmlNode | null, name: string, timing: Timing): number | null {
  const raw = attrOf(element, name);
  return raw != null ? parseTime(raw, timing) : null;
}

// ── Model ──────────────────────────────────────────────────────────────────

interface RawSegment {
  text: string;
  beginMs: number | null;
  endMs: number | null;
  durationMs: number | null;
}

interface RawTrack {
  text: string;
  language: string | null;
  segments: RawSegment[];
  beginMs: number | null;
  endMs: number | null;
  durationMs: number | null;
}

interface RawLine {
  key: string | null;
  sourceOrder: number;
  beginMs: number | null;
  endMs: number | null;
  durationMs: number | null;
  agentId: string | null;
  main: RawTrack;
  backgrounds: RawTrack[];
  translations: RawTrack[];
  romanizations: RawTrack[];
}

interface Segment {
  text: string;
  timing: [number, number] | null;
}

interface Track {
  text: string;
  language: string | null;
  segments: Segment[];
}

interface Agent {
  id: string;
  name: string | null;
  type: string;
  order: number;
}

interface Line {
  key: string | null;
  sourceOrder: number;
  startMs: number;
  endMs: number;
  text: string;
  main: Track;
  backgrounds: Track[];
  translations: Track[];
  romanizations: Track[];
  agent: Agent | null;
}

function normalizedText(value: string): string {
  return value.replace(WHITESPACE_RE, ' ').trim();
}

function normalizedEdge(value: string): string {
  return value.trim();
}

class TrackBuilder {
  language: string | null;
  text = '';
  segments: RawSegment[] = [];
  private pendingPrefix = '';

  constructor(language: string | null) {
    this.language = language;
  }

  appendSegment(segment: RawSegment): void {
    const originalText = segment.text;
    let seg = segment;
    if (this.pendingPrefix) {
      seg = { ...segment, text: this.pendingPrefix + segment.text };
      this.pendingPrefix = '';
    }
    this.segments.push(seg);
    this.text += originalText;
  }

  appendInterSpanText(value: string): void {
    let content: string;
    if (value.includes('\n') || value.includes('\r')) {
      content = value.trim();
      if (!content) return;
    } else {
      content = value;
      if (!content) return;
    }
    if (this.segments.length) {
      this.segments[this.segments.length - 1].text += content;
    } else {
      this.pendingPrefix += content;
    }
    this.text += content;
  }

  build(beginMs: number | null = null, endMs: number | null = null, durationMs: number | null = null): RawTrack {
    return {
      text: this.text,
      language: this.language,
      segments: [...this.segments],
      beginMs,
      endMs,
      durationMs,
    };
  }
}

function parseAgents(root: XmlNode): Agent[] {
  const agents: Agent[] = [];
  const els = descendants(root).filter((el) => hasLocalName(el, 'agent'));
  els.forEach((element, index) => {
    const agentId = attrOf(element, 'id');
    if (agentId == null) return;
    const nameEl = descendants(element).find((el) => hasLocalName(el, 'name'));
    let name: string | null = null;
    if (nameEl) name = normalizedText(iterText(nameEl)) || null;
    const typeRaw = (attrOf(element, 'type') ?? '').toLowerCase();
    const type =
      typeRaw === 'person' || typeRaw === 'character' || typeRaw === 'group' || typeRaw === 'organization'
        ? typeRaw
        : 'other';
    agents.push({ id: agentId.replace(/^#/, ''), name, type, order: index });
  });
  const seen = new Set<string>();
  return agents.filter((a) => {
    if (!a.id || seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}

function parseHeadTracks(
  root: XmlNode,
  containerName: string,
  timing: Timing,
): Map<string, RawTrack[]> {
  const result = new Map<string, RawTrack[]>();
  for (const container of descendants(root).filter((el) => hasLocalName(el, containerName))) {
    const language = attrOf(container, 'lang');
    for (const textEl of descendants(container).filter((el) => hasLocalName(el, 'text'))) {
      let lineKey = attrOf(textEl, 'for');
      if (lineKey == null) continue;
      lineKey = lineKey.replace(/^#/, '');
      const track = parseGenericTrack(textEl, language, timing);
      if (track.text.trim()) {
        const list = result.get(lineKey) ?? [];
        list.push(track);
        result.set(lineKey, list);
      }
    }
  }
  return result;
}

function parseGenericTrack(element: XmlNode, inheritedLanguage: string | null, timing: Timing): RawTrack {
  const language = attrOf(element, 'lang') ?? inheritedLanguage;
  const builder = new TrackBuilder(language);
  parseGenericNodes(element, builder, timing, true);
  return builder.build(attrTime(element, 'begin', timing), attrTime(element, 'end', timing), attrTime(element, 'dur', timing));
}

function parseGenericNodes(
  element: XmlNode,
  builder: TrackBuilder,
  timing: Timing,
  includeElementTiming: boolean,
): void {
  const spanChildren = directChildren(element).filter((c) => hasLocalName(c, 'span'));
  const beginMs = attrTime(element, 'begin', timing);
  const endMs = attrTime(element, 'end', timing);
  const durationMs = attrTime(element, 'dur', timing);
  if (includeElementTiming && !spanChildren.length && beginMs != null) {
    const text = iterText(element);
    if (text) builder.appendSegment({ text, beginMs, endMs, durationMs });
    return;
  }
  for (const node of childNodes(element)) {
    if (typeof node === 'string') builder.appendInterSpanText(node);
    else if (hasLocalName(node, 'span')) parseGenericNodes(node, builder, timing, true);
  }
}

function hasSupplementaryRole(element: XmlNode): boolean {
  return SUPPLEMENTARY_ROLES.has((attrOf(element, 'role') ?? '').toLowerCase());
}

function parseMainSpan(
  element: XmlNode,
  main: TrackBuilder,
  backgrounds: RawTrack[],
  translations: RawTrack[],
  romanizations: RawTrack[],
  timing: Timing,
): void {
  const directSpans = directChildren(element).filter((c) => hasLocalName(c, 'span'));
  for (const child of directSpans) {
    const role = (attrOf(child, 'role') ?? '').toLowerCase();
    if (role === 'x-bg') backgrounds.push(parseGenericTrack(child, main.language, timing));
    else if (role === 'x-translation') translations.push(parseGenericTrack(child, main.language, timing));
    else if (role === 'x-roman') romanizations.push(parseGenericTrack(child, main.language, timing));
  }
  const mainChildren = directSpans.filter((c) => !hasSupplementaryRole(c));
  const beginMs = attrTime(element, 'begin', timing);
  const endMs = attrTime(element, 'end', timing);
  const durationMs = attrTime(element, 'dur', timing);
  if (!mainChildren.length) {
    const text = !directSpans.length ? iterText(element) : directText(element);
    if (text) main.appendSegment({ text, beginMs, endMs, durationMs });
    return;
  }
  for (const node of childNodes(element)) {
    if (typeof node === 'string') main.appendInterSpanText(node);
    else if (hasLocalName(node, 'span') && !hasSupplementaryRole(node)) {
      parseMainSpan(node, main, backgrounds, translations, romanizations, timing);
    }
  }
}

function parseParagraphContent(
  paragraph: XmlNode,
  timing: Timing,
): { main: TrackBuilder; backgrounds: RawTrack[]; translations: RawTrack[]; romanizations: RawTrack[] } {
  const language = inheritedAttr(paragraph, 'lang');
  const main = new TrackBuilder(language);
  const backgrounds: RawTrack[] = [];
  const translations: RawTrack[] = [];
  const romanizations: RawTrack[] = [];
  for (const node of childNodes(paragraph)) {
    if (typeof node === 'string') {
      main.appendInterSpanText(node);
    } else if (hasLocalName(node, 'span')) {
      const role = (attrOf(node, 'role') ?? '').toLowerCase();
      if (role === 'x-bg') backgrounds.push(parseGenericTrack(node, language, timing));
      else if (role === 'x-translation') translations.push(parseGenericTrack(node, language, timing));
      else if (role === 'x-roman') romanizations.push(parseGenericTrack(node, language, timing));
      else parseMainSpan(node, main, backgrounds, translations, romanizations, timing);
    }
  }
  return {
    main,
    backgrounds: backgrounds.filter((t) => t.text.trim()),
    translations: translations.filter((t) => t.text.trim()),
    romanizations: romanizations.filter((t) => t.text.trim()),
  };
}

function parseRawLines(
  root: XmlNode,
  timing: Timing,
  headTranslations: Map<string, RawTrack[]>,
  headRomanizations: Map<string, RawTrack[]>,
): RawLine[] {
  const rawLines: RawLine[] = [];
  const paragraphs = descendants(root).filter((el) => hasLocalName(el, 'p'));
  paragraphs.forEach((paragraph, index) => {
    const content = parseParagraphContent(paragraph, timing);
    let key = attrOf(paragraph, 'key') ?? attrOf(paragraph, 'id');
    if (key != null) key = key.replace(/^#/, '');
    const mainBuilt = content.main.build();
    const mainText = normalizedEdge(mainBuilt.text);
    const visibleText = mainText || content.backgrounds.map((t) => normalizedText(t.text)).join(' ');
    if (!visibleText.trim()) return;
    let agentId = inheritedAttr(paragraph, 'agent');
    if (agentId != null) agentId = agentId.replace(/^#/, '');
    rawLines.push({
      key: key ?? null,
      sourceOrder: index,
      beginMs: attrTime(paragraph, 'begin', timing),
      endMs: attrTime(paragraph, 'end', timing),
      durationMs: attrTime(paragraph, 'dur', timing),
      agentId: agentId ?? null,
      main: mainBuilt,
      backgrounds: content.backgrounds,
      translations: [
        ...content.translations,
        ...(key ? headTranslations.get(key) ?? [] : []),
      ],
      romanizations: [
        ...content.romanizations,
        ...(key ? headRomanizations.get(key) ?? [] : []),
      ],
    });
  });
  return rawLines;
}

function resolveUnknownAgents(declared: Agent[], rawLines: RawLine[]): Agent[] {
  const agents = [...declared];
  const known = new Set(declared.map((a) => a.id));
  for (const rawLine of rawLines) {
    if (rawLine.agentId && !known.has(rawLine.agentId)) {
      known.add(rawLine.agentId);
      agents.push({ id: rawLine.agentId, name: null, type: 'person', order: agents.length });
    }
  }
  return agents;
}

function minimumRawBegin(rawLine: RawLine): number | null {
  const values: number[] = [];
  for (const track of allTracks(rawLine)) {
    if (track.beginMs != null) values.push(track.beginMs);
    for (const seg of track.segments) if (seg.beginMs != null) values.push(seg.beginMs);
  }
  return values.length ? Math.min(...values) : null;
}

function allTracks(rawLine: RawLine): RawTrack[] {
  return [rawLine.main, ...rawLine.backgrounds, ...rawLine.translations, ...rawLine.romanizations];
}

function maximumRawEnd(rawLine: RawLine, lineStart: number): number | null {
  const values: (number | null)[] = [];
  for (const track of allTracks(rawLine)) {
    let trackEnd = track.endMs;
    if (trackEnd == null && track.beginMs != null && track.durationMs != null) {
      trackEnd = track.beginMs + track.durationMs;
    }
    values.push(trackEnd);
    for (const segment of track.segments) {
      let segEnd = segment.endMs;
      if (segEnd == null && segment.beginMs != null && segment.durationMs != null) {
        segEnd = segment.beginMs + segment.durationMs;
      }
      values.push(segEnd);
    }
  }
  const nums = values.filter((v): v is number => v != null);
  if (!nums.length) return null;
  const rawMax = Math.max(...nums);
  return rawMax < lineStart ? lineStart + rawMax : rawMax;
}

function determineTrackOffset(rawTrack: RawTrack, lineRange: [number, number]): number {
  const segmentRanges: [number, number][] = [];
  for (const segment of rawTrack.segments) {
    if (segment.beginMs == null) continue;
    let end = segment.endMs;
    if (end == null && segment.durationMs != null) end = segment.beginMs + segment.durationMs;
    if (end == null) end = segment.beginMs;
    segmentRanges.push([segment.beginMs, end]);
  }
  let rawRanges: [number, number][];
  if (segmentRanges.length) {
    rawRanges = segmentRanges;
  } else {
    if (rawTrack.beginMs == null) return 0;
    const start = rawTrack.beginMs;
    let end = rawTrack.endMs;
    if (end == null && rawTrack.durationMs != null) end = start + rawTrack.durationMs;
    if (end == null) end = start;
    rawRanges = [[start, end]];
  }
  if (!rawRanges.length || lineRange[0] === 0) return 0;
  if (rawRanges.every(([s, e]) => s >= lineRange[0] && e <= lineRange[1])) return 0;
  if (
    rawRanges.every(
      ([s, e]) => s >= 0 && lineRange[0] + s >= lineRange[0] && lineRange[0] + e <= lineRange[1],
    )
  ) {
    return lineRange[0];
  }
  return 0;
}

function resolveTrack(rawTrack: RawTrack, lineRange: [number, number]): Track {
  const offset = determineTrackOffset(rawTrack, lineRange);
  const trackStart = rawTrack.beginMs != null ? rawTrack.beginMs + offset : lineRange[0];
  let trackEnd: number;
  if (rawTrack.endMs != null) trackEnd = rawTrack.endMs + offset;
  else if (rawTrack.durationMs != null) trackEnd = trackStart + rawTrack.durationMs;
  else trackEnd = lineRange[1];
  const starts = rawTrack.segments.map((seg) => (seg.beginMs != null ? seg.beginMs + offset : null));
  let resolved: Segment[] = rawTrack.segments.map((segment, idx) => {
    const start = starts[idx];
    let explicitEnd: number | null = null;
    if (segment.endMs != null) explicitEnd = segment.endMs + offset;
    else if (segment.durationMs != null && start != null) explicitEnd = start + segment.durationMs;
    const nextStart = starts.slice(idx + 1).find((s) => s != null) ?? null;
    const end = explicitEnd ?? nextStart ?? trackEnd;
    const timing: [number, number] | null =
      start != null && end != null && end > start && start >= 0 ? [start, end] : null;
    return { text: segment.text, timing };
  });
  if (
    resolved.length &&
    resolved.every((seg) => seg.timing == null) &&
    rawTrack.beginMs != null &&
    (rawTrack.endMs != null || rawTrack.durationMs != null) &&
    trackEnd > trackStart
  ) {
    resolved = [{ text: rawTrack.text, timing: [trackStart, trackEnd] }];
  }
  return { text: normalizedEdge(rawTrack.text), language: rawTrack.language, segments: resolved };
}

function resolveLines(
  rawLines: RawLine[],
  bodyEndMs: number | null,
  agentById: Map<string, Agent>,
): Line[] {
  const preliminaryStarts = rawLines.map((line) =>
    line.beginMs != null ? line.beginMs : minimumRawBegin(line),
  );
  const lines: Line[] = [];
  rawLines.forEach((rawLine, index) => {
    const lineStart = preliminaryStarts[index];
    if (lineStart == null) return;
    const nextStart =
      preliminaryStarts.slice(index + 1).find((s) => s != null && s > lineStart) ?? null;
    let declaredEnd = rawLine.endMs;
    if (declaredEnd == null && rawLine.durationMs != null) declaredEnd = lineStart + rawLine.durationMs;
    let preliminaryEnd: number | null;
    if (declaredEnd != null) {
      preliminaryEnd = declaredEnd;
    } else {
      preliminaryEnd = maximumRawEnd(rawLine, lineStart);
      if (preliminaryEnd == null) preliminaryEnd = nextStart;
      if (preliminaryEnd == null && bodyEndMs != null && bodyEndMs > lineStart) {
        preliminaryEnd = bodyEndMs;
      }
      if (preliminaryEnd == null) preliminaryEnd = lineStart + DEFAULT_FINAL_LINE_DURATION_MS;
    }
    if (preliminaryEnd <= lineStart) return;
    const main = resolveTrack(rawLine.main, [lineStart, preliminaryEnd]);
    const backgrounds = rawLine.backgrounds.map((t) => resolveTrack(t, [lineStart, preliminaryEnd]));
    const translations = rawLine.translations.map((t) => resolveTrack(t, [lineStart, preliminaryEnd]));
    const romanizations = rawLine.romanizations.map((t) => resolveTrack(t, [lineStart, preliminaryEnd]));
    const all = [main, ...backgrounds, ...translations, ...romanizations];
    const timings = all.flatMap((t) => t.segments).filter((s) => s.timing).map((s) => s.timing!);
    const effectiveStart = Math.min(lineStart, ...timings.map((t) => t[0]));
    const effectiveEnd = Math.max(preliminaryEnd, ...timings.map((t) => t[1]));
    if (effectiveEnd <= effectiveStart) return;
    let visibleText = normalizedEdge(main.text);
    if (!visibleText) visibleText = backgrounds.map((t) => normalizedText(t.text)).join(' ');
    lines.push({
      key: rawLine.key,
      sourceOrder: rawLine.sourceOrder,
      startMs: effectiveStart,
      endMs: effectiveEnd,
      text: visibleText,
      main: { ...main, text: normalizedEdge(main.text) },
      backgrounds: backgrounds.filter((t) => t.text.trim()),
      translations: translations.filter((t) => t.text.trim()),
      romanizations: romanizations.filter((t) => t.text.trim()),
      agent: rawLine.agentId ? agentById.get(rawLine.agentId) ?? null : null,
    });
  });
  return lines;
}

function chooseRomanization(tracks: Track[]): Track | null {
  for (const track of tracks) {
    if (track.language && track.language.toLowerCase().includes('latn')) return track;
  }
  return tracks[0] ?? null;
}

function parseDocument(ttml: string): Line[] {
  const source = ttml.replace(/^\uFEFF/, '').trimStart();
  if (UNSAFE_XML_RE.test(source)) throw new Error('unsafe XML');
  const root = parseXml(source);
  if (localName(root.tag) !== 'tt') throw new Error('malformed XML');
  const timing = readTimingContext(root);
  const body = descendants(root).find((el) => hasLocalName(el, 'body')) ?? null;
  let bodyStartMs = body ? attrTime(body, 'begin', timing) : null;
  bodyStartMs = bodyStartMs ?? 0;
  let bodyEndMs: number | null = null;
  if (body) {
    bodyEndMs = attrTime(body, 'end', timing);
    if (bodyEndMs == null) {
      const dur = attrTime(body, 'dur', timing);
      if (dur != null) bodyEndMs = bodyStartMs + dur;
    }
  }
  const declaredAgents = parseAgents(root);
  const headRomanizations = parseHeadTracks(root, 'transliteration', timing);
  const headTranslations = parseHeadTracks(root, 'translation', timing);
  const rawLines = parseRawLines(root, timing, headTranslations, headRomanizations);
  if (!rawLines.length) throw new Error('missing lines');
  const agents = resolveUnknownAgents(declaredAgents, rawLines);
  const lines = resolveLines(rawLines, bodyEndMs, new Map(agents.map((a) => [a.id, a])));
  if (!lines.length) throw new Error('invalid timing');
  return [...lines].sort((a, b) => a.startMs - b.startMs || a.sourceOrder - b.sourceOrder);
}

/** Parse TTML into line dicts; `[]` for any malformed/unsafe document. */
export function parseTtml(ttml: string): TtmlLine[] {
  let document: Line[];
  try {
    document = parseDocument(ttml);
  } catch {
    return [];
  }
  return document.map((line) => {
    const mainWords: TtmlWord[] = line.main.segments
      .filter((seg) => seg.timing != null)
      .map((seg) => ({
        text: seg.text,
        start: seg.timing![0] / MILLIS_PER_SECOND,
        end: seg.timing![1] / MILLIS_PER_SECOND,
        isBackground: false,
      }));
    const backgroundWords: TtmlWord[] = line.backgrounds.flatMap((track) =>
      track.segments
        .filter((seg) => seg.timing != null)
        .map((seg) => ({
          text: seg.text,
          start: seg.timing![0] / MILLIS_PER_SECOND,
          end: seg.timing![1] / MILLIS_PER_SECOND,
          isBackground: true,
        })),
    );
    const romanization = chooseRomanization(line.romanizations);
    return {
      text: line.text,
      start: line.startMs / MILLIS_PER_SECOND,
      end: line.endMs / MILLIS_PER_SECOND,
      words: [...mainWords, ...backgroundWords],
      agent: line.agent ? line.agent.id : null,
      providerRomanizedText: romanization ? normalizedText(romanization.text) : null,
      providerRomanizedWords:
        romanization != null
          ? (() => {
              const words = romanization.segments.map((s) => normalizedText(s.text)).filter(Boolean);
              return words.length ? words : null;
            })()
          : null,
      providerRomanizedLanguage: romanization ? romanization.language : null,
      providerTranslationText: line.translations.length
        ? normalizedText(line.translations[0].text)
        : null,
    };
  });
}
