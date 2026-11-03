/**
 * Lyrics provider chain preferences — pure helpers shared by the
 * settings store (migration/coercion) and the lyrics fetches.
 *
 * The model is Android's (`LyricsHelper` + `LyricsSettings`): an
 * ordered list of all 13 chain providers (order = preference) plus a
 * per-provider enable map, and a Paxsenix API key gating the three
 * Paxsenix providers. The legacy single `lyricsProvider` setting
 * migrates once into the order (see `migrateLegacyProvider`).
 */
import { LYRICS_CHAIN_IDS } from '../types/models';

/** Legacy single-provider values that have a chain equivalent. */
const LEGACY_PROVIDER_MAP: Record<string, string> = {
  lrclib: 'lrclib',
  megalobiz: 'megalobiz',
  musixmatch: 'paxsenix-musixmatch',
};

/**
 * Normalise a persisted order: drop unknown/duplicate ids, then append
 * any chain provider missing from it in default order — the chain is
 * always complete, so a provider can never vanish from Settings.
 */
export function normalizeProviderOrder(order: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const id of order ?? []) {
    if (typeof id === 'string' && LYRICS_CHAIN_IDS.includes(id) && !seen.has(id)) {
      seen.add(id);
      cleaned.push(id);
    }
  }
  for (const id of LYRICS_CHAIN_IDS) {
    if (!seen.has(id)) cleaned.push(id);
  }
  return cleaned;
}

/**
 * Parse a persisted order string (JSON, as the store serializes it).
 * Anything unparseable falls back to the default order.
 */
export function parseProviderOrder(raw: string | null | undefined): string[] {
  if (!raw) return [...LYRICS_CHAIN_IDS];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...LYRICS_CHAIN_IDS];
    return normalizeProviderOrder(parsed);
  } catch {
    return [...LYRICS_CHAIN_IDS];
  }
}

/**
 * Parse a persisted enable map (JSON). Unknown ids are dropped;
 * non-boolean values are ignored.
 */
export function parseProvidersEnabled(
  raw: string | null | undefined,
): Record<string, boolean> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const enabled: Record<string, boolean> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (LYRICS_CHAIN_IDS.includes(id) && typeof value === 'boolean') enabled[id] = value;
    }
    return enabled;
  } catch {
    return {};
  }
}

/** Whether a provider is enabled — absent from the map means enabled. */
export function isProviderEnabled(
  enabled: Record<string, boolean> | null | undefined,
  id: string,
): boolean {
  return enabled?.[id] !== false;
}

/** Enabled provider ids, in chain order. */
export function enabledProviderIds(
  order: readonly string[],
  enabled: Record<string, boolean> | null | undefined,
): string[] {
  return normalizeProviderOrder(order).filter((id) => isProviderEnabled(enabled, id));
}

/**
 * One-time migration of the old single `lyricsProvider` setting: a
 * legacy value that maps onto the chain moves to the front of the
 * order. `auto` (and unmappable values like `netease` / `genius`)
 * leave the order untouched. Returns the order unchanged when there
 * is nothing to migrate.
 */
export function migrateLegacyProvider(
  legacy: string | null | undefined,
  order: readonly string[],
): string[] {
  const mapped = legacy ? LEGACY_PROVIDER_MAP[legacy] : undefined;
  if (!mapped) return [...order];
  const normalized = normalizeProviderOrder(order);
  return [mapped, ...normalized.filter((id) => id !== mapped)];
}
