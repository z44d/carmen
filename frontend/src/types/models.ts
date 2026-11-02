/**
 * Shared domain model for the whole app.
 *
 * Everything downstream (repos, hooks, player, UI) speaks these types — the
 * raw API payloads only ever appear inside `utils/track` normalizers and
 * repository row mappers.
 */

/** One entry of the `artists` array — the API is inconsistent about shape. */
export type Artist = string | { name: string; id?: string | null };

export interface Thumbnail {
  url: string;
  width?: number;
  height?: number;
}

/** Normalized track: the shape every list and control in the UI consumes. */
export interface Track {
  videoId: string;
  title: string;
  artists: Artist[];
  artist: string;
  album: { name: string; id: string | null } | null;
  albumName: string;
  duration: string | null;
  durationSeconds: number | null;
  artwork: string | null;
  year: string | null;
  /** `YYYY-MM-DD` or `YYYY` when the API provides it (sortable). */
  releaseDate: string | null;
  isExplicit: boolean;
  playlistId: string | null;
}

/** Raw API item — intentionally loose, the API is a JSON blob soup. */
export type RawTrack = Record<string, unknown>;

export interface LyricLine {
  timeMs: number;
  endTimeMs?: number;
  text: string;
  /** Per-word karaoke stamps, when the source carries them (enhanced LRC). */
  words?: LyricWord[];
  /** Provider-supplied translation of this line (TTML/LRC second text). */
  translation?: string;
  /** Provider-supplied romanization of this line (TTML transliteration). */
  romanizedText?: string;
  /** Provider-supplied romanization per word, aligned with `words`. */
  romanizedWords?: string[];
  /** An instrumental break inserted between vocal lines (Android parity). */
  isInstrumental?: boolean;
  /** Singer label from TTML/QRC (`v1`, `v2`, …) — drives line alignment. */
  agent?: string;
  /** Instrumental break length in ms (only on instrumental lines). */
  durationMs?: number;
}

/** One karaoke word with explicit stamps (enhanced LRC), in milliseconds. */
export interface LyricWord {
  text: string;
  startMs: number;
  endMs: number;
  /** Background vocal — rendered on its own smaller row (Android parity). */
  isBackground?: boolean;
}

export interface TrackLyrics {
  browseId?: string | null;
  synced: LyricLine[] | null;
  unsynced: string | null;
  source: string | null;
  /** Chain provider id that produced these lyrics (see LYRICS_CHAIN). */
  provider?: string | null;
}

/** Enriched `/browsing/track/{id}` payload. */
export interface TrackMeta {
  videoId?: string;
  title?: string;
  artists?: Artist[];
  album?: string | { name?: string; id?: string | null; thumbnails?: Thumbnail[] };
  year?: string;
  genre?: string;
  duration?: string;
  duration_seconds?: number;
  thumbnails?: Thumbnail[];
  artwork?: string | null;
  lyrics?: TrackLyrics | null;
  playlistId?: string | null;
  [key: string]: unknown;
}

export type RepeatMode = 'off' | 'all' | 'one';

/** Persisted queue/history/seek position — restored on startup. */
export interface PlaybackSnapshot {
  queue: Track[];
  history: Track[];
  currentVideoId: string | null;
  positionMs: number;
  shuffle: boolean;
  repeat: RepeatMode;
  updatedAt: number;
}

export interface Playlist {
  id: number;
  name: string;
  description: string;
  coverVideoId: string | null;
  isFavorite: boolean;
  position: number;
  trackCount: number;
  createdAt: number;
  updatedAt: number;
}

/** A downloaded track joined with its file locations on disk. */
export interface DownloadedSong extends Track {
  audioPath: string;
  artworkPath: string | null;
  lyricsPath: string | null;
  lyricsSynced: boolean;
  bytes: number | null;
  downloadedAt: number;
  isFavorite: boolean;
}

/**
 * Any track as listed inside a playlist / the favorites smart list: knows
 * whether it is downloaded (playable offline) and whether it is a favorite.
 */
export interface PlaylistSong extends Track {
  isFavorite: boolean;
  isDownloaded: boolean;
  audioPath: string | null;
}

/** Lyrics provider selector — `auto` follows the backend's resolution chain. */
export type LyricsProvider =
  | 'auto'
  | 'lrclib'
  | 'musixmatch'
  | 'netease'
  | 'megalobiz'
  | 'genius';

export const LYRICS_PROVIDERS: { id: LyricsProvider; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'lrclib', label: 'LRCLIB' },
  { id: 'musixmatch', label: 'Musixmatch' },
  { id: 'netease', label: 'NetEase' },
  { id: 'megalobiz', label: 'Megalobiz' },
  { id: 'genius', label: 'Genius' },
];

/**
 * Lyrics provider chain, ported from the Android app (`LyricsHelper`):
 * the same 13 providers in the same default order. The order IS the
 * preference order — the first enabled provider wins ties, and the
 * server picks the best-quality result across enabled providers.
 * `youtube-subtitle` / `youtube-music` are always-on in Android and have
 * no server-side port (their coverage comes from the YouTube fallbacks);
 * they stay in the list so the order matches Android exactly.
 */
export const LYRICS_CHAIN: { id: string; label: string }[] = [
  { id: 'betterlyrics', label: 'BetterLyrics' },
  { id: 'betterlyrics-portato', label: 'BetterLyrics Portato' },
  { id: 'youlyplus', label: 'YouLyPlus' },
  { id: 'lrclib', label: 'LrcLib' },
  { id: 'kugou', label: 'Kugou' },
  { id: 'megalobiz', label: 'Megalobiz' },
  { id: 'simpmusic', label: 'SimpMusic' },
  { id: 'unison', label: 'Unison' },
  { id: 'paxsenix-apple-music', label: 'Paxsenix: Apple Music' },
  { id: 'paxsenix-spotify', label: 'Paxsenix: Spotify' },
  { id: 'paxsenix-musixmatch', label: 'Paxsenix: Musixmatch' },
  { id: 'youtube-subtitle', label: 'YouTube Subtitle' },
  { id: 'youtube-music', label: 'YouTube Music' },
];

export const LYRICS_CHAIN_IDS: string[] = LYRICS_CHAIN.map((provider) => provider.id);

/** Display name for a chain provider id (falls back to the raw id). */
export function lyricsChainLabel(id: string | null | undefined): string {
  return LYRICS_CHAIN.find((provider) => provider.id === id)?.label ?? id ?? 'Lyrics';
}

/** One provider's result from `GET /browsing/lyrics/providers`. */
export interface ProviderLyricsResult {
  provider: string;
  name: string;
  available: boolean;
  synced: LyricLine[] | null;
  unsynced: string | null;
  source: string | null;
}

export type ThemeMode = 'light' | 'dark' | 'system';
export type FontId = 'alexandria' | 'cairo' | 'system';
/** Text size of the lyrics inside the Now Playing card. */
export type LyricsSize = 'default' | 'large' | 'veryLarge';
/** Size of the album cover (thumbnail) inside the Now Playing card. */
export type CoverSize = 'default' | 'large' | 'veryLarge';
/**
 * Where an enabled animated artwork plays: `default` follows the device —
 * the whole player card on desktop, the lyrics background on a phone —
 * while the explicit values pin one surface on every device and
 * `thumbnail` animates the cover tile itself instead of any background.
 */
export type ArtworkPlacement = 'default' | 'lyrics' | 'player' | 'thumbnail';

/** Everything the Settings screen can change. Persisted in SQLite. */
export interface AppSettings {
  themeMode: ThemeMode;
  accent: string;
  adaptiveAccent: boolean;
  font: FontId;
  lyricsProvider: LyricsProvider;
  /**
   * Lyrics provider chain order (Android model): the first enabled
   * provider is preferred; the server picks the best-quality result
   * across enabled providers. Ids are `LYRICS_CHAIN` ids.
   */
  lyricsProviderOrder: string[];
  /**
   * Per-provider enable switches, keyed by chain id. Absent = enabled
   * (only an explicit `false` turns a provider off).
   */
  lyricsProvidersEnabled: Record<string, boolean>;
  /**
   * Paxsenix API key, gating the three Paxsenix providers (Android
   * parity). Empty = those providers are skipped. Sent to the server
   * only as a lyrics-request parameter — never logged, never stored
   * server-side — and never echoed anywhere in the UI.
   */
  paxsenixApiKey: string;
  /** Lyrics text size — the synced rows and the plain-text fallback alike. */
  lyricsSize: LyricsSize;
  /**
   * Word-by-word karaoke — inside the active line every word lights up as
   * the playhead passes it. Words use the source's own stamps when it has
   * them (enhanced LRC), otherwise the line's duration is spread evenly
   * across its words.
   */
  karaokeWords: boolean;
  /** Optional override of the FastAPI backend URL (empty = bundled default). */
  apiBase: string;
  /**
   * Low battery mode — no artwork-derived theme, white accent, no blur /
   * ambient effects: trade visual richness for a lighter, power-saving
   * render load. The manual toggle; the mode can also switch itself on
   * automatically below 20% battery (see `settings/battery.ts`).
   */
  lowBatteryMode: boolean;
  /**
   * Animated album artwork — covers that move in the Now Playing screen,
   * resolved through Apple's iTunes / amp-api catalogue (see
   * `artwork/motion.ts`): the whole card on desktop, only the lyrics page
   * on a phone. On by default; low battery mode switches it off on top of
   * this toggle.
   */
  animatedArtwork: boolean;
  /**
   * Where animated artwork plays (Settings → Animated artwork placement).
   * `default` follows the device (whole card on desktop, lyrics background
   * on a phone); `lyrics` / `player` pin one surface everywhere;
   * `thumbnail` animates the cover tile itself instead of a background.
   */
  animatedArtworkPlacement: ArtworkPlacement;
  /**
   * Album-cover size in the Now Playing card — the square thumbnail's
   * width cap, stepped up from the default ladder by Large / Very large.
   */
  coverSize: CoverSize;
  /**
   * Cinematic mode (desktop) — full screen drops every affordance: no
   * buttons, no scrubber, no tabs — just the song details and the lyrics
   * over the artwork backdrop. Escape leaves full screen again.
   */
  cinematicMode: boolean;
  /**
   * Keep the album cover on the left inside cinematic mode (default).
   * Off = the details and the lyrics take the full width instead.
   */
  cinematicCover: boolean;
  /**
   * Blur & glass effects — backdrop blur on the navigation and player
   * surfaces, accent glows and the ambient artwork wash. Off gives flat,
   * lighter surfaces. Low battery mode forces them off on top of this
   * toggle (see `useEffectsEnabled`).
   */
  blurEffects: boolean;
  /**
   * Artwork background — the ambient wash that tints the whole app with
   * the colors of the playing artwork (see `AmbientBackground`). Off keeps
   * the plain theme background. Low battery mode hides it too.
   */
  artworkBackground: boolean;
  /**
   * Lock-screen lyrics — mirrors the currently sung line into the OS media
   * widget's `metadata.artist`, so the lock screen / Control Center / car
   * display shows what is playing right now (the title keeps the track
   * name). Updates fire only when the active synced line changes, never per
   * playhead tick (see `services/mediaSession/lockScreenLyrics`).
   */
  lockScreenLyrics: boolean;
  /**
   * Smart downloads — once the listener is halfway through a song, it is
   * saved to the device automatically (unless it already lives there), so a
   * favorite keeps playing through a dead connection. The trigger lives in
   * `offline/smartDownload.ts`.
   */
  smartDownload: boolean;
}

export type SettingsKey = keyof AppSettings;
