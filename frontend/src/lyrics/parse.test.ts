import { describe, expect, it } from 'vitest';

import { displayLyricsText, hasWordSyncedLyrics, insertInstrumentalBreaks, parseLyrics } from './parse';

describe('parseLyrics: plain and line-synced LRC', () => {
  it('parses plain text as quality 0', () => {
    const parsed = parseLyrics('Hello\nWorld');
    expect(parsed.quality).toBe(0);
    expect(parsed.synced).toBeNull();
    expect(parsed.unsynced).toBe('Hello\nWorld');
  });

  it('parses line-synced LRC as quality 1 with end times filled', () => {
    const parsed = parseLyrics('[00:01.00]First\n[00:05.00]Second');
    expect(parsed.quality).toBe(1);
    expect(parsed.synced).toHaveLength(2);
    expect(parsed.synced?.[0].timeMs).toBe(1000);
    expect(parsed.synced?.[0].endTimeMs).toBe(5000);
    expect(parsed.synced?.[1].text).toBe('Second');
    expect(parsed.unsynced).toBe('First\nSecond');
  });

  it('parses enhanced-LRC word timings as quality 2', () => {
    const parsed = parseLyrics('[00:01.00]<00:01.00>Hel <00:01.50>lo');
    expect(parsed.quality).toBe(2);
    expect(parsed.synced?.[0].words).toHaveLength(2);
    // The inter-word space stays on the preceding word, as in the
    // server parser: word text is the raw slice up to the next stamp.
    expect(parsed.synced?.[0].words?.[0]).toMatchObject({ text: 'Hel ', startMs: 1000, endMs: 1500 });
    expect(parsed.synced?.[0].text).toBe('Hel lo');
  });

  it('merges a duplicate-timestamp line as a translation', () => {
    const parsed = parseLyrics('[00:01.00]Hello\n[00:01.00]Hola');
    expect(parsed.synced).toHaveLength(1);
    expect(parsed.synced?.[0].text).toBe('Hello');
    expect(parsed.synced?.[0].translation).toBe('Hola');
  });

  it('does not treat identical duplicate lines as translations', () => {
    const parsed = parseLyrics('[00:01.00]Hello\n[00:01.00]hello');
    expect(parsed.synced?.[0].translation).toBeUndefined();
  });

  it('parses millisecond-synced lines', () => {
    // No parenthesised word timings: the QRC path does not claim the
    // line, so the milliseconds line parser strips nothing and keeps
    // the whole text. (A `(start,dur)` fragment makes the QRC parser
    // claim the line and keep only the text before the timing group,
    // exactly as the server parser does.)
    const parsed = parseLyrics('[1000,4000]Hello world');
    expect(parsed.synced?.[0].timeMs).toBe(1000);
    expect(parsed.synced?.[0].text).toBe('Hello world');
  });

  it('returns nothing meaningful for LYRICS_NOT_FOUND', () => {
    expect(parseLyrics('LYRICS_NOT_FOUND')).toEqual({ synced: null, unsynced: null, quality: 0 });
    expect(parseLyrics('')).toEqual({ synced: null, unsynced: null, quality: 0 });
  });
});

describe('parseLyrics: QRC', () => {
  it('parses QRC word timings', () => {
    const qrc = '[1000,4000]Hello(1000,500) world(1500,500)';
    const parsed = parseLyrics(qrc);
    expect(parsed.quality).toBe(2);
    expect(parsed.synced?.[0].text).toBe('Hello world');
    expect(parsed.synced?.[0].words?.[0].startMs).toBe(1000);
    expect(parsed.synced?.[0].words?.[1].startMs).toBe(1500);
  });
});

describe('parseLyrics: TTML', () => {
  const ttml = `<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
    <p begin="00:00:01.000" end="00:00:04.000"><span begin="00:00:01.000" end="00:00:02.000">Hel</span><span begin="00:00:02.000" end="00:00:04.000">lo</span></p>
    <p begin="00:00:05.000" end="00:00:07.000">World</p>
  </div></body></tt>`;

  it('parses word timings from spans', () => {
    const parsed = parseLyrics(ttml);
    expect(parsed.quality).toBe(2);
    expect(parsed.synced).toHaveLength(2);
    expect(parsed.synced?.[0].timeMs).toBe(1000);
    expect(parsed.synced?.[0].words).toHaveLength(2);
    expect(parsed.synced?.[0].words?.[0]).toMatchObject({ text: 'Hel', startMs: 1000, endMs: 2000 });
    expect(parsed.synced?.[1].text).toBe('World');
  });

  it('rejects unsafe XML with a DOCTYPE', () => {
    const unsafe = `<?xml version="1.0"?><!DOCTYPE tt [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><tt><body><p begin="0s">Hi</p></body></tt>`;
    expect(parseLyrics(unsafe).synced).toBeNull();
  });

  it('exposes translation and romanization tracks', () => {
    const doc = `<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
      <p begin="1s" end="3s"><span>Hello</span><span role="x-translation">Hola</span><span role="x-roman" xml:lang="en-Latn">Herro</span></p>
    </div></body></tt>`;
    const parsed = parseLyrics(doc);
    expect(parsed.synced?.[0].translation).toBe('Hola');
    expect(parsed.synced?.[0].romanizedText).toBe('Herro');
  });

  it('drops Arabic-claimed romanization', () => {
    const doc = `<tt xmlns="http://www.w3.org/ns/ttml"><body><div>
      <p begin="1s" end="3s"><span>Hello</span><span role="x-roman" xml:lang="ar-Latn">Herro</span></p>
    </div></body></tt>`;
    const parsed = parseLyrics(doc);
    expect(parsed.synced?.[0].romanizedText).toBeUndefined();
  });

  it('detects word-synced TTML', () => {
    expect(hasWordSyncedLyrics(ttml)).toBe(true);
    expect(hasWordSyncedLyrics('<tt><body><p begin="1s">Hi</p></body></tt>')).toBe(false);
  });
});

describe('instrumental breaks', () => {
  it('inserts intro and outro breaks for long gaps', () => {
    const lines = insertInstrumentalBreaks(
      [
        { timeMs: 10000, endTimeMs: 12000, text: 'Hello' },
        { timeMs: 14000, endTimeMs: 16000, text: 'World' },
      ],
      30000,
    );
    expect(lines[0].isInstrumental).toBe(true);
    expect(lines[0].timeMs).toBe(1000);
    expect(lines[lines.length - 1].isInstrumental).toBe(true);
  });

  it('does not insert breaks for short gaps', () => {
    const lines = insertInstrumentalBreaks(
      [{ timeMs: 2000, endTimeMs: 4000, text: 'Hello' }],
      8000,
    );
    expect(lines).toHaveLength(1);
  });
});

describe('displayLyricsText', () => {
  it('strips enhanced word tags from plain display', () => {
    expect(displayLyricsText('[00:01.00]<00:01.00>Hello')).toBe('Hello');
  });
});
