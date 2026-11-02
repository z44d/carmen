import { Button, Chip, Switch, TextField, ToggleButton, ToggleButtonGroup } from '../components/ui';
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
import { LYRICS_CHAIN } from '../types/models';
import { isProviderEnabled, normalizeProviderOrder } from '../utils/lyricsProviders';
import type { ArtworkPlacement, CoverSize, FontId, LyricsSize, ThemeMode } from '../types/models';
import {
  DarkModeIcon,
  DevicePhoneMobileIcon,
  DownloadIcon,
  ExpandLessIcon,
  ExpandMoreIcon,
  GitHubIcon,
  InfoIcon,
  LightModeIcon,
  LyricsIcon,
  MusicNoteIcon,
  PlayArrowIcon,
  TelegramIcon,
  UserIcon,
  XIcon,
} from '../components/icons';

/** MUI's stock `warning.main` (light/dark) — the low-battery status lines. */
const WARNING_TEXT = 'text-[#ed6c02] dark:text-[#ff9800]';

/**
 * Titled section: a glass icon chip and a bold sentence-case heading with
 * an optional muted subtitle, then one glass card whose rows are split by
 * hairline dividers. One section per concern, one card per section — the
 * page reads top to bottom instead of as a stack of loose boxes. The
 * scroll margin clears the floating header and the sticky section nav
 * when a nav chip jumps here.
 */
function Section({
  id,
  icon,
  title,
  subtitle,
  children,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-[calc(var(--app-header)+72px)]">
      <div className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-full border border-line bg-surface/60 text-body shadow-glass backdrop-blur-xl">
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="m-0 text-[19px] font-bold leading-tight tracking-[-0.01em] md:text-xl">
            {title}
          </h2>
          {subtitle ? (
            <p className="m-0 mt-0.5 text-[13px] leading-[1.4] text-muted">{subtitle}</p>
          ) : null}
        </div>
      </div>
      <div className="mt-3 divide-y divide-line overflow-hidden rounded-[20px] border border-line bg-surface/55 shadow-glass backdrop-blur-2xl">
        {children}
      </div>
    </section>
  );
}

/** One toggle row: label and description left, control right, never wrapping orphans. */
function SettingRow({
  title,
  description,
  status,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** Extra status line under the description (battery / low-battery warnings). */
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-row items-center justify-between gap-4 px-4 py-4">
      <div className="min-w-0">
        <p className="m-0 text-sm font-semibold leading-[1.43]">{title}</p>
        {description ? (
          <span className="block text-xs leading-[1.4] text-muted">{description}</span>
        ) : null}
        {status}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** One choice block: label row (plus an optional status chip), the segmented control, a hint. */
function ChoiceBlock({
  title,
  chip,
  hint,
  children,
}: {
  title: string;
  chip?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="px-4 py-4">
      <div className="mb-2.5 flex flex-row items-center justify-between gap-3">
        <p className="m-0 text-sm font-semibold leading-[1.43]">{title}</p>
        {chip}
      </div>
      {children}
      {hint ? (
        <span className="mt-2 block text-xs leading-[1.4] text-muted">{hint}</span>
      ) : null}
    </div>
  );
}

/** Segmented choice group: wraps to two rows on a phone instead of squeezing its labels. */
function ChoiceGroup({
  value,
  onChange,
  label,
  twoCol,
  children,
}: {
  value: unknown;
  onChange: (event: React.MouseEvent<HTMLButtonElement>, value: unknown) => void;
  label: string;
  /** Four short options read better as a 2×2 grid than a squeezed row. */
  twoCol?: boolean;
  children: ReactNode;
}) {
  return (
    <ToggleButtonGroup
      exclusive
      value={value}
      onChange={onChange}
      aria-label={label}
      className={cn('w-full flex-wrap', twoCol && '[&>button]:basis-[calc(50%-2px)]')}
    >
      {children}
    </ToggleButtonGroup>
  );
}

/** One segment: wide enough that its label never wraps to two lines. */
function ChoiceOption({
  value,
  disabled,
  children,
}: {
  value: unknown;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <ToggleButton
      value={value}
      disabled={disabled}
      className="min-w-[96px] flex-1 whitespace-nowrap px-2 text-[13px]"
    >
      {children}
    </ToggleButton>
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
 * Sticky section quick-nav: a scrollable row of glass chips under the
 * title that jumps to each section. It sticks just below the floating
 * header, so jumping around a long page never means scrolling back to
 * the top first. No scroll-spy: the chips are plain jump links, and the
 * sections' scroll margin keeps their headings clear of the nav itself.
 */
function SectionNav({ items }: { items: { id: string; label: string }[] }) {
  return (
    <nav
      aria-label="Settings sections"
      className="sticky top-[calc(var(--app-header)+8px)] z-[1000]"
    >
      <div className="peek-row flex gap-2 overflow-x-auto py-1">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() =>
              document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
            className="shrink-0 whitespace-nowrap rounded-full border border-line bg-surface/70 px-4 py-2 text-[13px] font-semibold text-body shadow-glass backdrop-blur-xl transition hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.97]"
          >
            {item.label}
          </button>
        ))}
      </div>
    </nav>
  );
}

/**
 * Settings, reorganised: Appearance, Player, Lyrics, Downloads,
 * Storage, Server, About, Credits. The colour system is neutral by
 * design — there is no accent picker: active states and focus rings
 * wear the body text colour in both themes.
 *
 * Every persisted choice is written straight through the settings store;
 * the theme context lends the resolved mode for the status chip.
 */
export default function SettingsPage() {
  const {
    themeMode,
    font,
    lyricsProviderOrder,
    lyricsProvidersEnabled,
    paxsenixApiKey,
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
    <div className="mx-auto w-full max-w-[720px] px-4 pb-10 pt-6 md:px-10 md:pt-8">
      <div className="flex flex-col gap-7 md:gap-9">
        <div>
          <h5 className="m-0 text-[26px] font-extrabold leading-tight tracking-[-0.01em]">Settings</h5>
          <p className="m-0 text-sm leading-[1.43] text-muted">
            Personalize Carmen
          </p>
        </div>

        <SectionNav
          items={[
            { id: 'appearance', label: 'Appearance' },
            { id: 'player', label: 'Player' },
            { id: 'lyrics', label: 'Lyrics' },
            { id: 'downloads', label: 'Downloads' },
            { id: 'storage', label: 'Storage' },
            { id: 'server', label: 'Server' },
            ...(isTauri && info ? [{ id: 'about', label: 'About' }] : []),
            { id: 'credits', label: 'Credits' },
          ]}
        />

        <Section
          id="appearance"
          icon={<DarkModeIcon fontSize="small" />}
          title="Appearance"
          subtitle="Look and feel"
        >
          <ChoiceBlock
            title="Color mode"
            chip={
              <Chip
                size="small"
                label={`Currently ${resolved}`}
                variant="outlined"
                className="!border-accent/50 !text-accent"
              />
            }
            hint={
              <>
                System follows your device setting live.
              </>
            }
          >
            <ChoiceGroup
              value={themeMode}
              onChange={(_, value) => {
                if (value === 'light' || value === 'dark' || value === 'system') {
                  updateSettings({ themeMode: value satisfies ThemeMode });
                }
              }}
              label="Color mode"
            >
              <ChoiceOption value="light">
                <LightModeIcon fontSize="small" sx={{ mr: 0.75 }} /> Light
              </ChoiceOption>
              <ChoiceOption value="dark">
                <DarkModeIcon fontSize="small" sx={{ mr: 0.75 }} /> Dark
              </ChoiceOption>
              <ChoiceOption value="system">
                <DevicePhoneMobileIcon fontSize="small" sx={{ mr: 0.75 }} /> System
              </ChoiceOption>
            </ChoiceGroup>
          </ChoiceBlock>

          <ChoiceBlock
            title="Interface font"
            chip={
              <Chip
                size="small"
                label={selectedFont.name}
                variant="outlined"
                className="!border-accent/50 !text-accent"
              />
            }
            hint="Cairo and Alexandria download once, when you pick them."
          >
            <ChoiceGroup
              value={font}
              onChange={(_, value) => {
                if (value === 'alexandria' || value === 'cairo' || value === 'system') {
                  updateSettings({ font: value satisfies FontId });
                }
              }}
              label="Interface font"
            >
              {FONTS.map((option) => (
                <ChoiceOption key={option.id} value={option.id}>
                  {option.name}
                </ChoiceOption>
              ))}
            </ChoiceGroup>
            <div
              className="mt-2.5 rounded-[12px] bg-hover p-3"
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
          </ChoiceBlock>

          <SettingRow
            title="Blur effects"
            description="Glass backdrops and the ambient wash."
            status={
              lowBatteryActive && !blurEffects ? (
                <span className="block text-xs leading-[1.4] text-muted">
                  Low battery mode is on as well — both choices are respected when it leaves.
                </span>
              ) : undefined
            }
          >
            <Switch
              checked={blurEffects}
              onChange={(_, checked) => updateSettings({ blurEffects: checked })}
              inputProps={{ 'aria-label': 'Blur effects' }}
              className="shrink-0"
            />
          </SettingRow>

          <SettingRow
            title="Artwork background"
            description="Tint the background with the colors of the playing artwork."
            status={
              artworkBackground && lowBatteryActive ? (
                <span className={cn('block text-xs leading-[1.4]', WARNING_TEXT)}>
                  Hidden automatically — low battery mode is on.
                </span>
              ) : undefined
            }
          >
            <Switch
              checked={artworkBackground}
              onChange={(_, checked) => updateSettings({ artworkBackground: checked })}
              inputProps={{ 'aria-label': 'Artwork background' }}
              className="shrink-0"
            />
          </SettingRow>

          <SettingRow
            title="Low battery mode"
            description="Save power: turns off artwork theming, blur and ambient effects."
            status={
              battery.level !== null ? (
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
              ) : undefined
            }
          >
            <Switch
              checked={lowBatteryManual}
              onChange={(_, checked) => updateSettings({ lowBatteryMode: checked })}
              inputProps={{ 'aria-label': 'Low battery mode' }}
              className="shrink-0"
            />
          </SettingRow>
        </Section>

        <Section
          id="player"
          icon={<PlayArrowIcon fontSize="small" />}
          title="Player"
          subtitle="Now Playing, artwork and the lock screen"
        >
          <SettingRow
            title="Animated artwork"
            description="Moving album covers in Now Playing, fetched from Apple's iTunes catalogue."
            status={
              animatedArtwork && lowBatteryActive ? (
                <span className={cn('block text-xs leading-[1.4]', WARNING_TEXT)}>
                  Off automatically — low battery mode is on.
                </span>
              ) : undefined
            }
          >
            <Switch
              checked={animatedArtwork}
              onChange={(_, checked) => updateSettings({ animatedArtwork: checked })}
              inputProps={{ 'aria-label': 'Animated artwork' }}
              className="shrink-0"
            />
          </SettingRow>

          <ChoiceBlock
            title="Animated artwork placement"
            hint={
              <>
                Default follows the device. Lyrics bg and Player bg pin one surface;
                Cover animates the thumbnail.
              </>
            }
          >
            <ChoiceGroup
              value={animatedArtworkPlacement}
              twoCol
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
              label="Animated artwork placement"
            >
              <ChoiceOption disabled={!animatedArtwork} value="default">
                Default
              </ChoiceOption>
              <ChoiceOption disabled={!animatedArtwork} value="lyrics">
                Lyrics bg
              </ChoiceOption>
              <ChoiceOption disabled={!animatedArtwork} value="player">
                Player bg
              </ChoiceOption>
              <ChoiceOption disabled={!animatedArtwork} value="thumbnail">
                Cover
              </ChoiceOption>
            </ChoiceGroup>
          </ChoiceBlock>

          <ChoiceBlock
            title="Player cover size"
            hint="Width of the album cover inside the Now Playing card."
          >
            <ChoiceGroup
              value={coverSize}
              onChange={(_, value) => {
                if (value === 'default' || value === 'large' || value === 'veryLarge') {
                  updateSettings({ coverSize: value satisfies CoverSize });
                }
              }}
              label="Player cover size"
            >
              <ChoiceOption value="default">Default</ChoiceOption>
              <ChoiceOption value="large">Large</ChoiceOption>
              <ChoiceOption value="veryLarge">Very large</ChoiceOption>
            </ChoiceGroup>
          </ChoiceBlock>

          <SettingRow
            title="Cinematic mode"
            description="Full screen on desktop: only cover, details and lyrics. Press Esc to leave."
          >
            <Switch
              checked={cinematicMode}
              onChange={(_, checked) => updateSettings({ cinematicMode: checked })}
              inputProps={{ 'aria-label': 'Cinematic mode' }}
              className="shrink-0"
            />
          </SettingRow>

          <SettingRow
            title="Cover in cinematic mode"
            description="Keep the cover on the left in cinematic mode."
          >
            <Switch
              checked={cinematicCover}
              disabled={!cinematicMode}
              onChange={(_, checked) => updateSettings({ cinematicCover: checked })}
              inputProps={{ 'aria-label': 'Cover in cinematic mode' }}
              className="shrink-0"
            />
          </SettingRow>

          <SettingRow
            title="Lock screen lyrics"
            description="Show the sung line on your lock screen and car display."
          >
            <Switch
              checked={lockScreenLyrics}
              onChange={(_, checked) => updateSettings({ lockScreenLyrics: checked })}
              inputProps={{ 'aria-label': 'Lock screen lyrics' }}
              className="shrink-0"
            />
          </SettingRow>
        </Section>

        <Section
          id="lyrics"
          icon={<LyricsIcon fontSize="small" />}
          title="Lyrics"
          subtitle="Words on screen"
        >
          <ChoiceBlock
            title="Lyrics size"
            hint="Text size of the lyrics inside the Now Playing card."
          >
            <ChoiceGroup
              value={lyricsSize}
              onChange={(_, value) => {
                if (value === 'default' || value === 'large' || value === 'veryLarge') {
                  updateSettings({ lyricsSize: value satisfies LyricsSize });
                }
              }}
              label="Lyrics size"
            >
              <ChoiceOption value="default">Default</ChoiceOption>
              <ChoiceOption value="large">Large</ChoiceOption>
              <ChoiceOption value="veryLarge">Very large</ChoiceOption>
            </ChoiceGroup>
          </ChoiceBlock>

          <SettingRow
            title="Word-by-word karaoke"
            description="Highlight each word as it is sung."
          >
            <Switch
              checked={karaokeWords}
              onChange={(_, checked) => updateSettings({ karaokeWords: checked })}
              inputProps={{ 'aria-label': 'Word-by-word karaoke' }}
              className="shrink-0"
            />
          </SettingRow>

          <div className="px-4 py-4">
            <p className="m-0 mb-2 text-sm font-semibold leading-[1.43]">
              Lyrics providers
            </p>
            <p className="m-0 mb-3 text-xs leading-[1.4] text-muted">
              The order is the preference order — the first enabled provider wins
              ties, and the best-quality result across enabled providers is used.
            </p>
            <div className="flex flex-col gap-1">
              {normalizeProviderOrder(lyricsProviderOrder).map((providerId, index, order) => {
                const provider = LYRICS_CHAIN.find((entry) => entry.id === providerId) ?? {
                  id: providerId,
                  label: providerId,
                };
                const enabled = isProviderEnabled(lyricsProvidersEnabled, providerId);
                const move = (delta: -1 | 1) => {
                  const next = [...order];
                  const target = index + delta;
                  if (target < 0 || target >= next.length) return;
                  [next[index], next[target]] = [next[target], next[index]];
                  updateSettings({ lyricsProviderOrder: next });
                };
                return (
                  <div
                    key={provider.id}
                    className="flex w-full items-center gap-2 rounded-[12px] px-[10px] py-[6px] hover:bg-hover"
                  >
                    <span className="w-5 shrink-0 text-center text-xs font-semibold leading-[1.4] text-muted">
                      {index + 1}
                    </span>
                    <p className="m-0 min-w-0 flex-1 text-sm font-semibold leading-[1.43]">
                      {provider.label}
                    </p>
                    <button
                      type="button"
                      aria-label={`Move ${provider.label} up`}
                      disabled={index === 0}
                      onClick={() => move(-1)}
                      className="grid size-8 shrink-0 place-items-center rounded-full text-body transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.94] disabled:opacity-30"
                    >
                      <ExpandLessIcon />
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${provider.label} down`}
                      disabled={index === order.length - 1}
                      onClick={() => move(1)}
                      className="grid size-8 shrink-0 place-items-center rounded-full text-body transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.94] disabled:opacity-30"
                    >
                      <ExpandMoreIcon />
                    </button>
                    <Switch
                      checked={enabled}
                      onChange={(_, checked) =>
                        updateSettings({
                          lyricsProvidersEnabled: { ...lyricsProvidersEnabled, [providerId]: checked },
                        })
                      }
                      inputProps={{ 'aria-label': `Enable ${provider.label}` }}
                      className="shrink-0"
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div className="px-4 py-4">
            <p className="m-0 mb-2 text-sm font-semibold leading-[1.43]">
              Paxsenix API key
            </p>
            <p className="m-0 mb-3 text-xs leading-[1.4] text-muted">
              Required for the three Paxsenix providers above — without it they
              are skipped. The key is sent with lyrics requests only, and is
              never shown anywhere else.
            </p>
            <TextField
              type="password"
              label={paxsenixApiKey ? 'Paxsenix API key configured' : 'Paxsenix API key'}
              value={paxsenixApiKey}
              onChange={(event) => updateSettings({ paxsenixApiKey: event.target.value })}
              inputProps={{ 'aria-label': 'Paxsenix API key', autoComplete: 'off' }}
              fullWidth
            />
            <span className="mt-1 block text-xs leading-[1.4] text-muted">
              {paxsenixApiKey ? 'A key is saved.' : 'No key set.'}
            </span>
          </div>
        </Section>

        <Section
          id="downloads"
          icon={<DownloadIcon fontSize="small" />}
          title="Downloads"
          subtitle="Offline listening"
        >
          <SettingRow
            title="Smart downloads"
            description="Save a song offline automatically after you have listened to half of it."
          >
            <Switch
              checked={smartDownload}
              onChange={(_, checked) => updateSettings({ smartDownload: checked })}
              inputProps={{ 'aria-label': 'Smart downloads' }}
              className="shrink-0"
            />
          </SettingRow>

          <div className="px-4 py-4">
            <p className="m-0 text-sm leading-[1.43]">
              Downloads run entirely in your browser: audio is converted to MP3, tagged
              and saved with cover art and lyrics.
            </p>
            <span className="mt-1 block text-xs leading-[1.4] text-muted">
              Songs longer than 1 hour are not offered by the API.
            </span>
          </div>
        </Section>

        <Section
          id="storage"
          icon={<DevicePhoneMobileIcon fontSize="small" />}
          title="Storage"
          subtitle="Space on this device"
        >
          <SettingRow
            title="Cached streams"
            description={
              isTauri
                ? 'Played songs are cached for replay without network. Copies older than a week are dropped.'
                : 'Covers kept by the browser cache; streamed audio itself lives in the browser’s HTTP cache.'
            }
          >
            <div className="flex shrink-0 flex-row items-center gap-2">
              <span className="text-sm font-semibold tabular-nums text-muted">
                {storage ? formatBytes(storage.cache) : '…'}
              </span>
              <Button color="error" className="shrink-0" onClick={() => void clearCache()}>
                Clear
              </Button>
            </div>
          </SettingRow>

          <SettingRow
            title="Downloaded songs"
            description={
              storage
                ? `${storage.count} song${storage.count === 1 ? '' : 's'} · ${formatBytes(
                    storage.bytes,
                  )} on this device`
                : '…'
            }
          >
            <Button className="shrink-0" onClick={() => navigate('/settings/downloads')}>
              Manage
            </Button>
          </SettingRow>
        </Section>

        <Section
          id="server"
          icon={<MusicNoteIcon fontSize="small" />}
          title="Server"
          subtitle="Where Carmen gets its music"
        >
          <div className="px-4 py-4">
            <p className="m-0 mb-2.5 text-sm leading-[1.43]">
              Optional backend URL override. Leave empty to use the bundled default.
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
          <Section
            id="about"
            icon={<InfoIcon fontSize="small" />}
            title="About"
            subtitle="This build"
          >
            <div className="flex flex-row items-center justify-between gap-4 px-4 py-4">
              <p className="m-0 text-sm font-semibold leading-[1.43]">Version</p>
              <Chip size="small" label={`v${info.version}`} variant="outlined" />
            </div>
            <div className="flex flex-row items-center justify-between gap-4 px-4 py-4">
              <p className="m-0 text-sm font-semibold leading-[1.43]">Platform</p>
              <Chip
                size="small"
                label={`${info.platform} · ${info.arch}`}
                variant="outlined"
              />
            </div>
          </Section>
        ) : null}

        <Section
          id="credits"
          icon={<UserIcon fontSize="small" />}
          title="Credits"
          subtitle="The people behind Carmen"
        >
          <div className="flex flex-col gap-2.5 px-4 py-4">
            <div>
              <p className="m-0 text-sm font-bold leading-[1.43]">
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
    </div>
  );
}
