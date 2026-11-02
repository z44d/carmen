/**
 * Tests for the Android lyrics port's shared frontend helpers: RTL
 * detection (port of `LyricsV2.isRtlText`) and the provider-chain
 * preference model (order normalisation, enable map, legacy
 * migration). The server-side parsing (LRC/QRC/TTML, translation
 * merging, instrumental breaks, quality ranking) is exercised by the
 * Python scratch checks reported alongside this change — the frontend
 * never parses lyrics itself.
 */
import { describe, expect, it } from 'vitest';

import { LYRICS_CHAIN_IDS } from '../types/models';
import { isRtlText } from './lyrics';
import {
  enabledProviderIds,
  isProviderEnabled,
  migrateLegacyProvider,
  normalizeProviderOrder,
  parseProviderOrder,
  parseProvidersEnabled,
} from './lyricsProviders';

describe('isRtlText', () => {
  it('detects Arabic lines as RTL', () => {
    expect(isRtlText('أحبك يا حبيبي')).toBe(true);
  });

  it('detects Hebrew lines as RTL', () => {
    expect(isRtlText('שלום עולם')).toBe(true);
  });

  it('treats Latin lines as LTR', () => {
    expect(isRtlText('Hello world')).toBe(false);
  });

  it('uses the first strong character, skipping neutral prefixes', () => {
    expect(isRtlText('"أحبك"')).toBe(true);
    expect(isRtlText('(Hello)')).toBe(false);
    expect(isRtlText('123 أحبك')).toBe(true);
    expect(isRtlText('123 hello')).toBe(false);
  });

  it('returns false for empty or neutral-only text', () => {
    expect(isRtlText('')).toBe(false);
    expect(isRtlText('♪ ♫ …')).toBe(false);
  });
});

describe('normalizeProviderOrder', () => {
  it('returns the default order for empty input', () => {
    expect(normalizeProviderOrder([])).toEqual(LYRICS_CHAIN_IDS);
    expect(normalizeProviderOrder(null)).toEqual(LYRICS_CHAIN_IDS);
    expect(normalizeProviderOrder(undefined)).toEqual(LYRICS_CHAIN_IDS);
  });

  it('drops unknown and duplicate ids and appends missing providers', () => {
    expect(normalizeProviderOrder(['kugou', 'nope', 'kugou', 'lrclib'])).toEqual([
      'kugou',
      'lrclib',
      ...LYRICS_CHAIN_IDS.filter((id) => id !== 'kugou' && id !== 'lrclib'),
    ]);
  });

  it('keeps a complete custom order as-is', () => {
    const reversed = [...LYRICS_CHAIN_IDS].reverse();
    expect(normalizeProviderOrder(reversed)).toEqual(reversed);
  });
});

describe('parseProviderOrder / parseProvidersEnabled', () => {
  it('falls back to the default order on malformed JSON', () => {
    expect(parseProviderOrder('not json')).toEqual(LYRICS_CHAIN_IDS);
    expect(parseProviderOrder('{"a":1}')).toEqual(LYRICS_CHAIN_IDS);
    expect(parseProviderOrder('')).toEqual(LYRICS_CHAIN_IDS);
  });

  it('completes a partial persisted order', () => {
    expect(parseProviderOrder(JSON.stringify(['unison']))).toEqual([
      'unison',
      ...LYRICS_CHAIN_IDS.filter((id) => id !== 'unison'),
    ]);
  });

  it('parses the enable map, dropping unknown ids and non-booleans', () => {
    expect(
      parseProvidersEnabled(JSON.stringify({ kugou: false, nope: true, lrclib: 'yes', unison: true })),
    ).toEqual({ kugou: false, unison: true });
    expect(parseProvidersEnabled('garbage')).toEqual({});
    expect(parseProvidersEnabled('')).toEqual({});
  });
});

describe('isProviderEnabled / enabledProviderIds', () => {
  it('treats an absent entry as enabled', () => {
    expect(isProviderEnabled({}, 'kugou')).toBe(true);
    expect(isProviderEnabled(null, 'kugou')).toBe(true);
    expect(isProviderEnabled({ kugou: true }, 'kugou')).toBe(true);
    expect(isProviderEnabled({ kugou: false }, 'kugou')).toBe(false);
  });

  it('lists enabled ids in chain order (normalised to the full chain)', () => {
    expect(enabledProviderIds(['unison', 'kugou', 'lrclib'], { kugou: false })).toEqual([
      'unison',
      'lrclib',
      ...LYRICS_CHAIN_IDS.filter((id) => !['unison', 'kugou', 'lrclib'].includes(id)),
    ]);
  });
});

describe('migrateLegacyProvider', () => {
  it('moves a mapped legacy provider to the front', () => {
    expect(migrateLegacyProvider('lrclib', LYRICS_CHAIN_IDS)).toEqual([
      'lrclib',
      ...LYRICS_CHAIN_IDS.filter((id) => id !== 'lrclib'),
    ]);
    expect(migrateLegacyProvider('musixmatch', LYRICS_CHAIN_IDS)[0]).toBe('paxsenix-musixmatch');
    expect(migrateLegacyProvider('megalobiz', ['kugou', 'megalobiz', 'lrclib'])).toEqual([
      'megalobiz',
      'kugou',
      'lrclib',
      ...LYRICS_CHAIN_IDS.filter((id) => !['kugou', 'megalobiz', 'lrclib'].includes(id)),
    ]);
  });

  it('leaves the order untouched for auto, unmapped, and empty values', () => {
    expect(migrateLegacyProvider('auto', LYRICS_CHAIN_IDS)).toEqual(LYRICS_CHAIN_IDS);
    expect(migrateLegacyProvider('netease', LYRICS_CHAIN_IDS)).toEqual(LYRICS_CHAIN_IDS);
    expect(migrateLegacyProvider('genius', LYRICS_CHAIN_IDS)).toEqual(LYRICS_CHAIN_IDS);
    expect(migrateLegacyProvider(null, LYRICS_CHAIN_IDS)).toEqual(LYRICS_CHAIN_IDS);
    expect(migrateLegacyProvider(undefined, LYRICS_CHAIN_IDS)).toEqual(LYRICS_CHAIN_IDS);
  });

  it('does not duplicate a provider that is already first', () => {
    const order = ['lrclib', 'kugou'];
    const migrated = migrateLegacyProvider('lrclib', order);
    expect(migrated.filter((id) => id === 'lrclib')).toHaveLength(1);
    expect(migrated[0]).toBe('lrclib');
  });
});
