import {
  Button,
  Chip,
  Container,
  Divider,
  Paper,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from '../components/ui';
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '../utils/cn';
import { FONTS, fontStack } from '../theme';
import { useTheme } from '../theme/ThemeContext';
import { useBattery } from '../settings/battery';
import { updateSettings, useLowBatteryMode, useSettings } from '../settings/store';
import { appInfo, isTauri, type AppInfo } from '../platform/env';
import { listDownloads } from '../db/repos/downloads';
import { notify } from '../utils/downloadsStore';
import { formatBytes } from '../utils/format';
import { appCacheSize, clearAppCache } from '../utils/streamCache';
import { LYRICS_PROVIDERS } from '../types/models';
import type { ArtworkPlacement, CoverSize, FontId, LyricsSize, ThemeMode } from '../types/models';
import {
  CheckIcon,
  DarkModeIcon,
  DevicePhoneMobileIcon,
  GitHubIcon,
  LightModeIcon,
  TelegramIcon,
  XIcon,
} from '../components/icons';

/** MUI's stock `warning.main` (light/dark) — the low-battery status lines. */
const WARNING_TEXT = 'text-[#ed6c02] dark:text-[#ff9800]';

/** Titled card grouping one group of settings. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="m-0 text-[19px] font-bold leading-tight tracking-[-0.01em]">
        {title}
      </h2>
      <Paper variant="outlined" className="mt-3 rounded-[12px] p-4">
        {children}
      </Paper>
    </section>
  );
}

/** Props for the credit link chip. */
interface CreditProps {
  href: string;
  name: string;
  icon: ReactElement;
  iconColor: string;
  children: ReactNode;
}

/**
 * Credit link: the platform's own mark with the handle beside it, opening
 * in a new tab.  `name` is what a screen reader hears — the visible label
 * is only the handle, the icon carries the rest.
 */
function Credit({ href, name, icon, iconColor, children }: CreditProps) {
  // Icons inherit the chip's own text colour: no brand hues in the
  // credits row — every mark wears the same neutral chrome.
  const painted = /^(#|rgb|hsl|var\()/i.test(iconColor);
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`${name} — ${children}`}
      className="inline-flex"
    >
      <Chip
        size="small"
        variant="outlined"
        className="font-semibold"
        label={
          <span className="inline-flex items-center gap-1">
            <span
              className="inline-flex text-[17px]"
              style={painted ? { color: iconColor } : undefined}
            >
              {icon}
            </span>
            {children}
          </span>
        }
      />
    </a>
  );
}

/**
 * Theme engine controls: color mode + interface font. The colour system
 * is neutral by design — there is no accent picker: active states and
 * focus rings wear the body text colour in both themes.
 *
 * Every persisted choice is written straight through the settings store;
 * the theme context lends the resolved mode for the status chip.
 */
export default function SettingsPage() {
  const {
    themeMode,
    font,
    lyricsProvider,
    lyricsSize,
    apiBase,
    lowBatteryMode: lowBatteryManual,
    animatedArtwork,
    animatedArtworkPlacement,
    coverSize,
    cinematicMode,
    cinematicCover,
    blurEffects,
    artworkBackground,
    lockScreenLyrics,
    karaokeWords,
    smartDownload,
  } = useSettings();
  // The *effective* mode (manual toggle or the automatic low-battery
  // kick-in) and the reading behind its status line.
  const lowBatteryActive = useLowBatteryMode();
  const battery = useBattery();
  const { resolved } = useTheme();
  const selectedFont = FONTS.find((option) => option.id === font) || FONTS[0];

  // App version + runtime facts (Settings → About). Tauri only — the web
  // build is whatever CI deployed, so there is nothing to version-check.
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    if (!isTauri) return undefined;
    let cancelled = false;
    appInfo()
      .then((facts) => {
        if (!cancelled) setInfo(facts);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const navigate = useNavigate();

  // Storage numbers (Settings → Storage): the cache on this platform plus
  // what the offline catalogue adds up to. Read on mount — the manage page
  // is its own route, so coming back from it re-runs this effect.
  const [storage, setStorage] = useState<{ cache: number; count: number; bytes: number } | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    void Promise.all([appCacheSize().catch(() => 0), listDownloads().catch(() => [])])
      .then(([cache, songs]) => {
        if (cancelled) return;
        setStorage({
          cache,
          count: songs.length,
          bytes: songs.reduce((total, song) => total + (song.bytes || 0), 0),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const clearCache = async () => {
    try {
      await clearAppCache();
      setStorage((current) => (current ? { ...current, cache: 0 } : current));
      notify('success', 'Cache cleared');
    } catch {
      notify('error', 'Could not clear the cache');
    }
  };

  return (
    <Container maxWidth="sm" className="pb-10 pt-6 md:pt-8">
      <div className="flex flex-col gap-9">
        <div>
          <h5 className="m-0 text-[26px] font-extrabold leading-tight tracking-[-0.01em]">Settings</h5>
          <p className="m-0 text-sm leading-[1.43] text-muted">
            Personalize Carmen
          </p>
        </div>

        <Section title="Appearance">
          <div className="flex flex-col gap-4">
            <div>
              <div className="mb-2 flex flex-row items-center justify-between">
                <p className="m-0 text-sm leading-[1.43] font-semibold">
                  Color mode
                </p>
                <Chip
                  size="small"
                  label={`Currently ${resolved}`}
                  variant="outlined"
                  className="!border-accent/50 !text-accent"
                />
              </div>
              <ToggleButtonGroup
                exclusive
                value={themeMode}
                onChange={(_, value) => {
                  if (value === 'light' || value === 'dark' || value === 'system') {
                    updateSettings({ themeMode: value satisfies ThemeMode });
                  }
                }}
                aria-label="Color mode"
                className="w-full"
              >
                <ToggleButton value="light" className="flex-1">
                  <LightModeIcon fontSize="small" sx={{ mr: 0.75 }} /> Light
                </ToggleButton>
                <ToggleButton value="dark" className="flex-1">
                  <DarkModeIcon fontSize="small" sx={{ mr: 0.75 }} /> Dark
                </ToggleButton>
                <ToggleButton value="system" className="flex-1">
                  <DevicePhoneMobileIcon fontSize="small" sx={{ mr: 0.75 }} /> System
                </ToggleButton>
              </ToggleButtonGroup>
              <span className="mt-[6px] block text-xs leading-[1.4] text-muted">
                System follows your device&apos;s <b>prefers-color-scheme</b> setting live.
              </span>
            </div>

            <Divider />

            <div>
              <div className="mb-2 flex flex-row items-center justify-between">
                <p className="m-0 text-sm leading-[1.43] font-semibold">
                  Interface font
                </p>
                <Chip
                  size="small"
                  label={selectedFont.name}
                  variant="outlined"
                  className="!border-accent/50 !text-accent"
                />
              </div>
              <ToggleButtonGroup
                exclusive
                value={font}
                onChange={(_, value) => {
                  if (value === 'alexandria' || value === 'cairo' || value === 'system') {
                    updateSettings({ font: value satisfies FontId });
                  }
                }}
                aria-label="Interface font"
                className="w-full"
              >
                {FONTS.map((option) => (
                  <ToggleButton key={option.id} value={option.id} className="flex-1">
                    {option.name}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
              <div
                className="mt-[10px] rounded-[12px] bg-hover p-3"
                style={{ fontFamily: fontStack(font) }}
              >
                <p className="m-0 truncate font-bold">
                  Carmen — {selectedFont.name}
                </p>
                <span className="block text-xs leading-[1.4] text-muted">
                  The quick brown fox jumps over the lazy dog
                </span>
                <span
                  dir="rtl"
                  className="mt-[2px] block text-xs leading-[1.4] text-muted"
                >
                  اسمعني — موسيقى بلا حدود
                </span>
              </div>
              <span className="mt-[6px] block text-xs leading-[1.4] text-muted">
                Cairo and Alexandria are loaded from Fontsource and only
                downloaded once you pick them.
              </span>
            </div>



            <Divider />

            <div className="flex flex-row items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="m-0 text-sm leading-[1.43] font-semibold">
                  Low battery mode
                </p>
                <span className="block text-xs leading-[1.4] text-muted">
                  Saves power by disabling artwork theming, blur and ambient
                  effects.
                </span>
                {battery.level !== null && (
                  <span
                    className={cn(
                      'block text-xs leading-[1.4]',
                      lowBatteryActive && !lowBatteryManual ? WARNING_TEXT : 'text-muted',
                    )}
                  >
                    {lowBatteryActive && !lowBatteryManual
                      ? `On automatically — battery at ${Math.round(battery.level * 100)}%.`
                      : `Battery at ${Math.round(battery.level * 100)}%${
                          battery.charging ? ', charging' : ''
                        } — turns itself on below 20% while on battery.`}
                  </span>
                )}
              </div>
              <Switch
                checked={lowBatteryManual}
                onChange={(_, checked) => updateSettings({ lowBatteryMode: checked })}
                inputProps={{ 'aria-label': 'Low battery mode' }}
                className="shrink-0"
              />
            </div>

            <Divider />

            <div className="flex flex-row items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="m-0 text-sm leading-[1.43] font-semibold">
                  Animated artwork
                </p>
                <span className="block text-xs leading-[1.4] text-muted">
                  Album covers that move in the Now Playing screen, fetched
                  from Apple's iTunes catalogue — the whole card on
                  desktop, the lyrics page on a phone. Downloads keep a
                  copy for offline playback.
                </span>
                {animatedArtwork && lowBatteryActive && (
                  <span className={cn('block text-xs leading-[1.4]', WARNING_TEXT)}>
                    Off automatically — low battery mode is on.
                  </span>
                )}
              </div>
              <Switch
                checked={animatedArtwork}
                onChange={(_, checked) => updateSettings({ animatedArtwork: checked })}
                inputProps={{ 'aria-label': 'Animated artwork' }}
                className="shrink-0"
              />
            </div>

            <Divider />

            <div>
              <p className="m-0 mb-2 text-sm leading-[1.43] font-semibold">
                Animated artwork placement
              </p>
              <ToggleButtonGroup
                exclusive
                value={animatedArtworkPlacement}
                onChange={(_, value) => {
                  if (
                    value === 'default' ||
                    value === 'lyrics' ||
                    value === 'player' ||
                    value === 'thumbnail'
                  ) {
                    updateSettings({
                      animatedArtworkPlacement: value satisfies ArtworkPlacement,
                    });
                  }
                }}
                aria-label="Animated artwork placement"
                className="w-full"
              >
                <ToggleButton disabled={!animatedArtwork} value="default" className="flex-1">
                  Default
                </ToggleButton>
                <ToggleButton disabled={!animatedArtwork} value="lyrics" className="flex-1">
                  Lyrics bg
                </ToggleButton>
                <ToggleButton disabled={!animatedArtwork} value="player" className="flex-1">
                  Player bg
                </ToggleButton>
                <ToggleButton disabled={!animatedArtwork} value="thumbnail" className="flex-1">
                  Cover
                </ToggleButton>
              </ToggleButtonGroup>
              <span className="mt-[6px] block text-xs leading-[1.4] text-muted">
                <b>Default</b> follows the device — the whole player card on
                desktop, the lyrics background on a phone. <b>Lyrics bg</b> and{' '}
                <b>Player bg</b> pin one surface on every device;{' '}
                <b>Cover</b> animates the album thumbnail instead.
              </span>
            </div>

            <Divider />

            <div className="flex flex-row items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="m-0 text-sm leading-[1.43] font-semibold">
                  Blur effects
                </p>
                <span className="block text-xs leading-[1.4] text-muted">
                  Glass backdrops and the ambient wash — off
                  gives flat, lighter surfaces.
                </span>
                {lowBatteryActive && !blurEffects && (
                  <span className="block text-xs leading-[1.4] text-muted">
                    Low battery mode is on as well — both choices are
                    respected when it leaves.
                  </span>
                )}
              </div>
              <Switch
                checked={blurEffects}
                onChange={(_, checked) => updateSettings({ blurEffects: checked })}
                inputProps={{ 'aria-label': 'Blur effects' }}
                className="shrink-0"
              />
            </div>

            <Divider />

            <div className="flex flex-row items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="m-0 text-sm leading-[1.43] font-semibold">
                  Artwork background
                </p>
                <span className="block text-xs leading-[1.4] text-muted">
                  Wash the app background with the colors of the artwork that
                  is playing. Off keeps the plain theme background.
                </span>
                {artworkBackground && lowBatteryActive && (
                  <span className={cn('block text-xs leading-[1.4]', WARNING_TEXT)}>
                    Hidden automatically — low battery mode is on.
                  </span>
                )}
              </div>
              <Switch
                checked={artworkBackground}
                onChange={(_, checked) => updateSettings({ artworkBackground: checked })}
                inputProps={{ 'aria-label': 'Artwork background' }}
                className="shrink-0"
              />
            </div>

            <Divider />

            <div>
              <p className="m-0 mb-2 text-sm leading-[1.43] font-semibold">
                Player cover size
              </p>
              <ToggleButtonGroup
                exclusive
                value={coverSize}
                onChange={(_, value) => {
                  if (value === 'default' || value === 'large' || value === 'veryLarge') {
                    updateSettings({ coverSize: value satisfies CoverSize });
                  }
                }}
                aria-label="Player cover size"
                className="w-full"
              >
                <ToggleButton value="default" className="flex-1">
                  Default
                </ToggleButton>
                <ToggleButton value="large" className="flex-1">
                  Large
                </ToggleButton>
                <ToggleButton value="veryLarge" className="flex-1">
                  Very large
                </ToggleButton>
              </ToggleButtonGroup>
              <span className="mt-[6px] block text-xs leading-[1.4] text-muted">
                Width of the album cover inside the Now Playing card.
              </span>
            </div>

            <Divider />

            <div className="flex flex-row items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="m-0 text-sm leading-[1.43] font-semibold">
                  Cinematic mode
                </p>
                <span className="block text-xs leading-[1.4] text-muted">
                  Desktop full screen drops every button, the scrubber and
                  the tab strip — only the cover, the song details and the
                  lyrics remain, over the artwork backdrop. Press Esc to
                  leave.
                </span>
              </div>
              <Switch
                checked={cinematicMode}
                onChange={(_, checked) => updateSettings({ cinematicMode: checked })}
                inputProps={{ 'aria-label': 'Cinematic mode' }}
                className="shrink-0"
              />
            </div>

            <div className="flex flex-row items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="m-0 text-sm leading-[1.43] font-semibold">
                  Cover in cinematic mode
                </p>
                <span className="block text-xs leading-[1.4] text-muted">
                  Keeps the album cover on the left. Turn it off for the
                  details and the lyrics to take the full width.
                </span>
              </div>
              <Switch
                checked={cinematicCover}
                disabled={!cinematicMode}
                onChange={(_, checked) => updateSettings({ cinematicCover: checked })}
                inputProps={{ 'aria-label': 'Cover in cinematic mode' }}
                className="shrink-0"
              />
            </div>

            <Divider />

            <div className="flex flex-row items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="m-0 text-sm leading-[1.43] font-semibold">
                  Lock screen lyrics
                </p>
                <span className="block text-xs leading-[1.4] text-muted">
                  Mirrors the currently sung line onto the lock screen,
                  Control Center and car displays — the track title stays
                  where it belongs. Updates only when the line changes,
                  never while it is being sung.
                </span>
              </div>
              <Switch
                checked={lockScreenLyrics}
                onChange={(_, checked) => updateSettings({ lockScreenLyrics: checked })}
                inputProps={{ 'aria-label': 'Lock screen lyrics' }}
                className="shrink-0"
              />
            </div>

          </div>
        </Section>

        <Section title="Lyrics">
          <div className="flex flex-col gap-4">
            <div>
              <p className="m-0 mb-2 text-sm leading-[1.43] font-semibold">
                Lyrics size
              </p>
              <ToggleButtonGroup
                exclusive
                value={lyricsSize}
                onChange={(_, value) => {
                  if (value === 'default' || value === 'large' || value === 'veryLarge') {
                    updateSettings({ lyricsSize: value satisfies LyricsSize });
                  }
                }}
                aria-label="Lyrics size"
                className="w-full"
              >
                <ToggleButton value="default" className="flex-1">
                  Default
                </ToggleButton>
                <ToggleButton value="large" className="flex-1">
                  Large
                </ToggleButton>
                <ToggleButton value="veryLarge" className="flex-1">
                  Very large
                </ToggleButton>
              </ToggleButtonGroup>
              <span className="mt-[6px] block text-xs leading-[1.4] text-muted">
                Text size of the lyrics inside the Now Playing card.
              </span>
            </div>

            <div className="flex flex-row items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="m-0 text-sm leading-[1.43] font-semibold">
                  Word-by-word karaoke
                </p>
                <span className="block text-xs leading-[1.4] text-muted">
                  Inside the active line, each word lights up as it is sung —
                  the line's duration spread evenly over its words when the
                  source carries no per-word stamps.
                </span>
              </div>
              <Switch
                checked={karaokeWords}
                onChange={(_, checked) => updateSettings({ karaokeWords: checked })}
                inputProps={{ 'aria-label': 'Word-by-word karaoke' }}
                className="shrink-0"
              />
            </div>

            <div className="flex flex-col gap-1">
            {LYRICS_PROVIDERS.map((provider) => {
              const selected = lyricsProvider === provider.id;
              return (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => updateSettings({ lyricsProvider: provider.id })}
                  aria-pressed={selected}
                  className={cn(
                    'flex w-full cursor-pointer items-center justify-between gap-3',
                    'rounded-[12px] border-0 px-[10px] py-[6px] text-left text-body hover:bg-hover',
                    selected && 'bg-hover',
                  )}
                >
                  <div className="min-w-0">
                    <p className="m-0 text-sm leading-[1.43] font-semibold">
                      {provider.label}
                    </p>
                    {provider.id === 'auto' && (
                      <span className="block text-xs leading-[1.4] text-muted">
                        YouTube first, then the best public source
                      </span>
                    )}
                  </div>
                  {selected && <CheckIcon color="primary" sx={{ fontSize: 18 }} />}
                </button>
              );
            })}
            </div>
          </div>
        </Section>

        <Section title="Downloads">
          <div className="flex flex-col gap-1">
            <div className="flex flex-row items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="m-0 text-sm leading-[1.43] font-semibold">
                  Smart downloads
                </p>
                <span className="block text-xs leading-[1.4] text-muted">
                  Once you have listened to half of a song, it is saved to this
                  device automatically, so it keeps playing offline. Songs
                  already on the device are skipped.
                </span>
              </div>
              <Switch
                checked={smartDownload}
                onChange={(_, checked) => updateSettings({ smartDownload: checked })}
                inputProps={{ 'aria-label': 'Smart downloads' }}
                className="shrink-0"
              />
            </div>

            <p className="m-0 pt-2 text-sm leading-[1.43]">
              Every <b>Download</b> runs entirely in your browser: the audio is fetched from the
              server buffer, converted to MP3 with ffmpeg.wasm and tagged with the title, artists,
              album, year, genre, cover art and the lyrics — synced lyrics are written as LRC
              timestamps — before being saved.
            </p>
            <span className="text-xs leading-[1.4] text-muted">
              Songs longer than 1 hour are not offered by the API.
            </span>
          </div>
        </Section>

        <Section title="Storage">
          <div className="flex flex-col gap-1">
            <div className="flex flex-row items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="m-0 text-sm leading-[1.43] font-semibold">Cached streams</p>
                <span className="block text-xs leading-[1.4] text-muted">
                  {isTauri
                    ? 'Songs played from the network are parked in the app cache, so replaying them needs no network. Copies older than a week are dropped automatically.'
                    : 'Covers kept by the browser cache; streamed audio itself lives in the browser’s HTTP cache.'}
                </span>
              </div>
              <div className="flex shrink-0 flex-row items-center gap-2">
                <span className="text-sm font-semibold tabular-nums text-muted">
                  {storage ? formatBytes(storage.cache) : '…'}
                </span>
                <Button color="error" className="shrink-0" onClick={() => void clearCache()}>
                  Clear
                </Button>
              </div>
            </div>

            <Divider />

            <div className="flex flex-row items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="m-0 text-sm leading-[1.43] font-semibold">Downloaded songs</p>
                <span className="block text-xs leading-[1.4] text-muted">
                  {storage
                    ? `${storage.count} song${storage.count === 1 ? '' : 's'} · ${formatBytes(
                        storage.bytes,
                      )} on this device`
                    : '…'}
                </span>
              </div>
              <Button className="shrink-0" onClick={() => navigate('/settings/downloads')}>
                Manage
              </Button>
            </div>
          </div>
        </Section>

        <Section title="Server">
          <div className="flex flex-col gap-2">
            <p className="m-0 text-sm leading-[1.43]">
              Optional override of the backend URL — leave the field empty to use the bundled
              default.
            </p>
            <TextField
              fullWidth
              size="small"
              value={apiBase}
              placeholder="http://localhost:8000"
              onChange={(event) => updateSettings({ apiBase: event.target.value })}
              inputProps={{ 'aria-label': 'Backend API base URL' }}
            />
          </div>
        </Section>

        {isTauri && info ? (
          <Section title="About">
            <div className="flex flex-col gap-2">
              <div className="flex flex-row items-center justify-between">
                <p className="m-0 text-sm leading-[1.43] font-semibold">Version</p>
                <Chip size="small" label={`v${info.version}`} variant="outlined" />
              </div>
              <div className="flex flex-row items-center justify-between">
                <p className="m-0 text-sm leading-[1.43] font-semibold">Platform</p>
                <Chip
                  size="small"
                  label={`${info.platform} · ${info.arch}`}
                  variant="outlined"
                />
              </div>
            </div>
          </Section>
        ) : null}

        <Section title="Credits">
          <div className="flex flex-col gap-[10px]">
            <div>
              <p className="m-0 text-sm leading-[1.43] font-bold">
                Zaid Ballour
              </p>
              <span className="text-xs leading-[1.4] text-muted">
                Design, development and maintenance of Carmen
              </span>
            </div>
            <div className="flex flex-row flex-wrap gap-2">
              <Credit
                href="https://github.com/z44d"
                name="GitHub"
                icon={<GitHubIcon fontSize="inherit" />}
                iconColor="text.primary"
              >
                @z44d
              </Credit>
              <Credit
                href="https://x.com/0z44d"
                name="X"
                icon={<XIcon fontSize="inherit" />}
                iconColor="text.primary"
              >
                @0z44d
              </Credit>
              <Credit
                href="https://t.me/zaidballour"
                name="Telegram"
                icon={<TelegramIcon fontSize="inherit" />}
                iconColor="text.primary"
              >
                @zaidballour
              </Credit>
            </div>
          </div>
        </Section>
      </div>
    </Container>
  );
}
