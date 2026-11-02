/**
 * Application settings — one store, persisted in SQLite (`settings` table),
 * read synchronously by React through `useSyncExternalStore`.
 *
 * `hydrateSettings()` runs once during bootstrap (see `main.tsx`) *before*
 * React renders, so the first frame already wears the saved theme / lyrics
 * provider. Legacy `localStorage` keys from the web build are migrated into
 * the database the first time the app runs.
 */
import { useSyncExternalStore } from 'react';

import { getSetting, setSetting } from '../db/repos/settings';
import type {
  AppSettings,
  ArtworkPlacement,
  CoverSize,
  FontId,
  LyricsProvider,
  LyricsSize,
  SettingsKey,
  ThemeMode,
} from '../types/models';
import { LYRICS_CHAIN_IDS } from '../types/models';
import {
  migrateLegacyProvider,
  normalizeProviderOrder,
  parseProviderOrder,
  parseProvidersEnabled,
} from '../utils/lyricsProviders';
import { isBatteryLow, useBattery } from './battery';

export const DEFAULT_SETTINGS: AppSettings = {
  themeMode: 'system',
  accent: '#fafafa',
  adaptiveAccent: false,
  font: 'alexandria',
  lyricsProvider: 'auto',
  lyricsProviderOrder: [...LYRICS_CHAIN_IDS],
  lyricsProvidersEnabled: {},
  paxsenixApiKey: '',
  lyricsSize: 'default',
  karaokeWords: true,
  apiBase: '',
  lowBatteryMode: false,
  animatedArtwork: true,
  animatedArtworkPlacement: 'default',
  coverSize: 'default',
  cinematicMode: false,
  cinematicCover: true,
  blurEffects: true,
  artworkBackground: true,
  lockScreenLyrics: true,
  smartDownload: false,
};

const KEYS: SettingsKey[] = [
  'themeMode',
  'accent',
  'adaptiveAccent',
  'font',
  'lyricsProvider',
  'lyricsProviderOrder',
  'lyricsProvidersEnabled',
  'paxsenixApiKey',
  'lyricsSize',
  'karaokeWords',
  'apiBase',
  'lowBatteryMode',
  'animatedArtwork',
  'animatedArtworkPlacement',
  'coverSize',
  'cinematicMode',
  'cinematicCover',
  'blurEffects',
  'artworkBackground',
  'lockScreenLyrics',
  'smartDownload',
];

/** Pre-SQLite storage keys, read once so existing choices survive. */
const LEGACY_KEYS: Partial<Record<SettingsKey, string[]>> = {
  themeMode: ['carmen:themeMode', 'samma3ni:themeMode'],
  accent: ['carmen:accent', 'samma3ni:accent'],
  adaptiveAccent: ['carmen:adaptiveAccent'],
  font: ['carmen:font.v2'],
};

/**
 * SQLite keys renamed after the setting shipped — read once so an existing
 * choice survives under its new name (the value is re-persisted there).
 */
const RENAMED_KEYS: Partial<Record<SettingsKey, string>> = {
  lowBatteryMode: 'highPerformance',
};

const THEME_MODES: ThemeMode[] = ['light', 'dark', 'system'];
const FONTS: FontId[] = ['alexandria', 'cairo', 'system'];
const LYRICS: LyricsProvider[] = ['auto', 'lrclib', 'musixmatch', 'netease', 'megalobiz', 'genius'];
const LYRICS_SIZES: LyricsSize[] = ['default', 'large', 'veryLarge'];
const COVER_SIZES: CoverSize[] = ['default', 'large', 'veryLarge'];
const ARTWORK_PLACEMENTS: ArtworkPlacement[] = ['default', 'lyrics', 'player', 'thumbnail'];

let snapshot: AppSettings = { ...DEFAULT_SETTINGS };
let hydrated = false;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

function readLegacy(key: SettingsKey): string | null {
  try {
    for (const legacyKey of LEGACY_KEYS[key] ?? []) {
      const value = window.localStorage.getItem(legacyKey);
      if (value) return value;
    }
  } catch {
    /* private mode */
  }
  return null;
}

function coerce(key: SettingsKey, raw: string): AppSettings[SettingsKey] {
  switch (key) {
    case 'themeMode':
      return THEME_MODES.includes(raw as ThemeMode) ? (raw as ThemeMode) : DEFAULT_SETTINGS.themeMode;
    case 'font':
      return FONTS.includes(raw as FontId) ? (raw as FontId) : DEFAULT_SETTINGS.font;
    case 'lyricsProvider':
      return LYRICS.includes(raw as LyricsProvider)
        ? (raw as LyricsProvider)
        : DEFAULT_SETTINGS.lyricsProvider;
    case 'lyricsProviderOrder':
      return parseProviderOrder(raw);
    case 'lyricsProvidersEnabled':
      return parseProvidersEnabled(raw);
    case 'paxsenixApiKey':
      // Stored verbatim; the UI never echoes it back.
      return raw;
    case 'lyricsSize':
      return LYRICS_SIZES.includes(raw as LyricsSize)
        ? (raw as LyricsSize)
        : DEFAULT_SETTINGS.lyricsSize;
    case 'coverSize':
      return COVER_SIZES.includes(raw as CoverSize)
        ? (raw as CoverSize)
        : DEFAULT_SETTINGS.coverSize;
    case 'animatedArtworkPlacement':
      return ARTWORK_PLACEMENTS.includes(raw as ArtworkPlacement)
        ? (raw as ArtworkPlacement)
        : DEFAULT_SETTINGS.animatedArtworkPlacement;
    case 'adaptiveAccent':
      return raw === '1' || raw === 'true';
    case 'lowBatteryMode':
      return raw === '1' || raw === 'true';
    case 'cinematicMode':
      // Absent = off: it hides most of the player chrome, opt-in only.
      return raw === '1' || raw === 'true';
    case 'smartDownload':
      // Absent = off: auto-saving songs costs storage, so it is opt-in.
      return raw === '1' || raw === 'true';
    case 'animatedArtwork':
    case 'blurEffects':
    case 'artworkBackground':
    case 'lockScreenLyrics':
    case 'karaokeWords':
    case 'cinematicCover':
      // Absent = on: only an explicit "0" turns the feature off.
      return raw !== '0' && raw !== 'false';
    case 'accent':
      return /^#[0-9a-f]{6}$/i.test(raw) ? raw : DEFAULT_SETTINGS.accent;
    case 'apiBase':
      return raw;
    default:
      return raw;
  }
}

function serialize(key: SettingsKey, value: AppSettings[SettingsKey]): string {
  if (key === 'lyricsProviderOrder' || key === 'lyricsProvidersEnabled') {
    return JSON.stringify(value ?? (key === 'lyricsProviderOrder' ? [] : {}));
  }
  if (
    key === 'adaptiveAccent' ||
    key === 'lowBatteryMode' ||
    key === 'animatedArtwork' ||
    key === 'blurEffects' ||
    key === 'artworkBackground' ||
    key === 'lockScreenLyrics' ||
    key === 'smartDownload' ||
    key === 'karaokeWords' ||
    key === 'cinematicMode' ||
    key === 'cinematicCover'
  ) {
    return value ? '1' : '0';
  }
  return String(value ?? '');
}

/** Loads persisted settings (plus one-time legacy migration) into memory. */
export async function hydrateSettings(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  const next: AppSettings = { ...DEFAULT_SETTINGS };
  let sawOrderRaw = false;
  for (const key of KEYS) {
    let raw: string | null = null;
    try {
      raw = await getSetting(key);
    } catch {
      raw = null;
    }
    if (raw === null || raw === undefined) {
      const legacy = readLegacy(key);
      if (legacy !== null) {
        raw = legacy;
        void setSetting(key, legacy).catch(() => {});
      }
    }
    if (raw === null || raw === undefined) {
      // Renamed key (e.g. `highPerformance` → `lowBatteryMode`): carry the
      // stored choice over under its new name.
      const previousKey = RENAMED_KEYS[key];
      if (previousKey) {
        try {
          const previous = await getSetting(previousKey);
          if (previous !== null && previous !== undefined) {
            raw = previous;
            void setSetting(key, previous).catch(() => {});
          }
        } catch {
          /* no previous value */
        }
      }
    }
    if (raw !== null && raw !== undefined) {
      if (key === 'lyricsProviderOrder') sawOrderRaw = true;
      Object.assign(next, { [key]: coerce(key, raw) });
    }
  }
  // One-time migration of the legacy single-provider setting: when no
  // chain order was ever persisted, a legacy choice that maps onto the
  // chain moves to the front. The migrated order is persisted, so this
  // runs once; afterwards the old key is no longer read for lyrics.
  if (!sawOrderRaw) {
    const migrated = migrateLegacyProvider(next.lyricsProvider, next.lyricsProviderOrder);
    if (migrated.join(',') !== next.lyricsProviderOrder.join(',')) {
      next.lyricsProviderOrder = migrated;
      void setSetting('lyricsProviderOrder', JSON.stringify(migrated)).catch(() => {});
    }
  }
  snapshot = next;
  notify();
}

export function getSettingsSnapshot(): AppSettings {
  return snapshot;
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Patch + persist. Writes are fire-and-forget; reads are synchronous. */
export function updateSettings(patch: Partial<AppSettings>): void {
  snapshot = { ...snapshot, ...patch };
  notify();
  for (const [key, value] of Object.entries(patch)) {
    const settingsKey = key as SettingsKey;
    if (value === undefined) continue;
    void setSetting(settingsKey, serialize(settingsKey, value as AppSettings[SettingsKey])).catch(
      (error) => console.warn('[settings] persist failed', settingsKey, error),
    );
  }
}

/** Live view of every persisted setting. */
export function useSettings(): AppSettings {
  return useSyncExternalStore(subscribeSettings, getSettingsSnapshot, getSettingsSnapshot);
}

/**
 * Whether the low-battery mode is active **right now**: the manual toggle,
 * or the automatic kick-in below 20% battery (see `settings/battery.ts`).
 * Every consumer that changes appearance reads this — not the raw setting —
 * so manual and automatic activation are indistinguishable downstream.
 */
export function useLowBatteryMode(): boolean {
  const manual = useSettings().lowBatteryMode;
  const battery = useBattery();
  return manual || isBatteryLow(battery);
}

/**
 * Whether the expensive visual effects should paint at all: blur and
 * backdrop-filter, accent glows and the ambient artwork background.
 *
 * Low battery mode switches them off app-wide — manually or automatically —
 * and so does the manual "Blur effects" choice in Settings; every
 * effectful component asks through this hook instead of reaching for the
 * raw setting: the meaning lives in one place and the call sites read as
 * intent.
 */
export function useEffectsEnabled(): boolean {
  // HOOKS MUST NEVER SIT BEHIND `&&`/`||`: short-circuiting used to skip
  // `useSettings()` whenever low battery mode turned on, dropping the
  // calling component's hook count by one and crashing it with
  // "Rendered fewer hooks than expected". Both hooks run unconditionally;
  // only the booleans are combined.
  const lowBattery = useLowBatteryMode();
  const blurEffects = useSettings().blurEffects;
  return !lowBattery && blurEffects;
}

/**
 * Whether the app background may wear the playing artwork's colors (the
 * ambient wash in `AmbientBackground`). The Settings choice, minus low
 * battery mode — and the wash itself also needs `useEffectsEnabled`, since
 * it *is* a giant blur.
 */
export function useArtworkBackground(): boolean {
  // Unconditional hooks, combined afterwards — see useEffectsEnabled:
  // skipping `useLowBatteryMode()` behind `settings.artworkBackground`
  // crashed every toggling consumer the same way.
  const { artworkBackground } = useSettings();
  const lowBattery = useLowBatteryMode();
  return artworkBackground && !lowBattery;
}

/**
 * Whether animated (motion) artwork may resolve and play **right now**:
 * the settings toggle, minus low battery mode — which switches the effect
 * off entirely (see `artwork/motion.ts` for what it costs: a couple of
 * catalogue requests and a small video per album, once).
 */
export function useAnimatedArtwork(): boolean {
  // Unconditional hooks, combined afterwards — see useEffectsEnabled.
  const { animatedArtwork } = useSettings();
  const lowBattery = useLowBatteryMode();
  return animatedArtwork && !lowBattery;
}
