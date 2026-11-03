import { describe, expect, it } from 'vitest';

import { captionsToLrc, parseJson3Captions, parseWebVtt } from './captions';

describe('parseJson3Captions', () => {
  it('turns events with segments into timed lines', () => {
    const lines = parseJson3Captions({
      events: [
        { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
        { tStartMs: 2500, dDurationMs: 1500, segs: [{ utf8: 'Second line' }] },
        { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: '   ' }] },
        { tStartMs: 6000, dDurationMs: 1000 },
      ],
    });
    expect(lines).toEqual([
      { timeMs: 0, endMs: 2000, text: 'Hello world' },
      { timeMs: 2500, endMs: 4000, text: 'Second line' },
    ]);
  });

  it('returns nothing for non-objects and missing events', () => {
    expect(parseJson3Captions(null)).toEqual([]);
    expect(parseJson3Captions('nope')).toEqual([]);
    expect(parseJson3Captions({})).toEqual([]);
  });
});

describe('parseWebVtt', () => {
  it('parses cues and strips inline tags', () => {
    const lines = parseWebVtt(
      [
        'WEBVTT',
        '',
        '00:00:01.000 --> 00:00:03.500',
        'Hello <c.color>world</c>',
        '',
        '00:00:04.000 --> 00:00:06.000',
        'Second <00:00:04.500>line here',
      ].join('\n'),
    );
    expect(lines).toEqual([
      { timeMs: 1000, endMs: 3500, text: 'Hello world' },
      { timeMs: 4000, endMs: 6000, text: 'Second line here' },
    ]);
  });

  it('ignores header metadata and cue identifiers', () => {
    const lines = parseWebVtt(
      ['WEBVTT', 'Kind: captions', 'Language: en', '', 'cue-1', '00:00:00.500 --> 00:00:02.000', 'Hi'].join('\n'),
    );
    expect(lines).toEqual([{ timeMs: 500, endMs: 2000, text: 'Hi' }]);
  });
});

describe('captionsToLrc', () => {
  it('serialises timed lines as LRC', () => {
    expect(
      captionsToLrc([
        { timeMs: 0, text: 'Hello world' },
        { timeMs: 61500, text: 'One minute in' },
      ]),
    ).toBe('[00:00.00]Hello world\n[01:01.50]One minute in');
    expect(captionsToLrc([])).toBeNull();
  });
});
