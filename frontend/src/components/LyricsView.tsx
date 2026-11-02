import { useEffect, useMemo, useRef, useState } from 'react';

import { fetchTrackMeta } from '../api';
import { fetchClientBestLyrics, fetchClientProviderLyrics } from '../lyrics/chain';
import { inferLyricsQuality } from '../lyrics/parse';
import { usePlayer } from '../player/PlayerContext';
import { useSettings } from '../settings/store';
import type { LyricLine, TrackLyrics } from '../types/models';
import { lyricsChainLabel } from '../types/models';
import { cn } from '../utils/cn';
import LyricsProviderPicker from './LyricsProviderPicker';
import { Shimmer } from './ui';
import SyncedLyrics from './SyncedLyrics';

interface LyricsViewProps {
  /** Timestamped lines of the playing song, or `null` when there are none. */
  synced?: LyricLine[] | null;
  /** Plain text fallback for songs without timestamps. */
  unsynced?: string | null;
  /** Attribution of the lyrics provider, shown under the text. */
  source?: string | null;
  /** Chain provider id behind these lyrics, when the server reports it. */
  provider?: string | null;
  /** True while the track metadata — and with it the lyrics — is loading. */
  loading?: boolean;
  /** Identity of the playing song, for the provider picker. */
  track?: {
    videoId: string;
    title?: string;
    artist?: string;
    album?: string;
    durationSeconds?: number;
  } | null;
}

/** Metadata that has not arrived by then counts as "no lyrics". */
const LOAD_TIMEOUT_MS = 6000;

/**
 * MIGRATION: the fade keyframes used to live in the plain-text page's
 * `Typography` sx; `styles.css` is off limits, so the block ships inline.
 */
const LYRICS_FADE_KEYFRAMES = `@keyframes lyrics-fade {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}`;

/**
 * Lyrics panel — a synced karaoke view with a plain-text fallback.
 *
 * **Following the song.**  The synced view is handed to `SyncedLyrics`, the
 * in-house engine: a playhead probe feeds a binary search, React state only
 * changes when the *line* changes, a self-stopping rAF loop eases the
 * scroller to the centred line, and the rows themselves are windowed by
 * `@tanstack/react-virtual` and `React.memo`'d — so a tick costs an
 * `O(log n)` search and nothing else, and only the lines whose highlight
 * actually changed repaint.  A wheel, finger or scrollbar drag from the
 * reader suspends the follow for 2.5s (`SyncedLyrics`), and a tapped line
 * resumes it immediately while it seeks the song there.
 *
 * **Highlight.** The active line wears the accent colour plus a slight
 * scale and weight — a transform, so nothing in the list reflows while the
 * song plays — while neighbouring lines dim by distance from it, past
 * lines fading exactly like future ones at the same distance (Android's
 * LyricsV2). Word stamps light up word by word when the source carries
 * them; provider romanization rides above its line and translation
 * below it, both at just over half size.
 *
 * **Provider chip + picker.** The chip names the provider behind the
 * lyrics on screen; tapping it opens the per-provider search (Android's
 * lyrics search dialog) and pinning one provider re-fetches this song
 * only — the chain order in Settings is never changed from here.
 *
 * Typography follows the theme, which carries the interface font setting
 * (see `settings/store` + `theme/ThemeContext`), and lines use a comfortable
 * unitless line height so the rows keep a steady rhythm no matter which font
 * is selected.
 *
 * Falls back to a scrollable plain text page (always pinned to the top)
 * when no timestamps exist, and to a quiet empty state otherwise.
 */
export default function LyricsView({
  synced,
  unsynced,
  source,
  provider,
  loading = false,
  track,
}: LyricsViewProps) {
  const { seek, current } = usePlayer();
  // The plain-text page follows the same size setting as the synced rows.
  const { lyricsSize, lyricsProviderOrder, lyricsProvidersEnabled, paxsenixApiKey } = useSettings();
  const unsyncedFontSize =
    lyricsSize === 'veryLarge' ? '1.45rem' : lyricsSize === 'large' ? '1.22rem' : '1.05rem';

  /** Only the plain-text fallback scrolls by hand — the engine owns its box. */
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const [timedOut, setTimedOut] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Provider pinned for this song only — cleared on every song change. */
  const [pinnedProvider, setPinnedProvider] = useState<string | null>(null);
  const [pinnedLyrics, setPinnedLyrics] = useState<TrackLyrics | null>(null);
  const [pinnedLoading, setPinnedLoading] = useState(false);
  /** Best client-chain lyrics for this song, fetched in the background. */
  const [clientLyrics, setClientLyrics] = useState<TrackLyrics | null>(null);

  const videoId = track?.videoId ?? current?.videoId ?? null;

  useEffect(() => {
    setPinnedProvider(null);
    setPinnedLyrics(null);
    setClientLyrics(null);
    setPickerOpen(false);
  }, [videoId]);

  // A pinned provider first tries the client chain for that single
  // provider (direct, then CORS relay), falling back to the server
  // metadata fetch with the pin only when the client returns nothing
  // for it. The global order/enabled/key travel along unchanged.
  useEffect(() => {
    if (!pinnedProvider || !videoId) return undefined;
    let cancelled = false;
    setPinnedLoading(true);
    void (async () => {
      try {
        const client = await fetchClientProviderLyrics(
          {
            videoId,
            title: track?.title ?? current?.title,
            artist: track?.artist ?? current?.artist,
            album: track?.album,
            durationSeconds: track?.durationSeconds ?? current?.durationSeconds ?? undefined,
            order: lyricsProviderOrder,
            enabled: lyricsProvidersEnabled,
            ...(paxsenixApiKey ? { paxsenixKey: paxsenixApiKey } : {}),
            provider: pinnedProvider,
          },
        );
        if (!cancelled && client) {
          setPinnedLyrics({
            synced: client.synced,
            unsynced: client.unsynced,
            source: client.name,
            provider: client.provider,
          });
          setPinnedLoading(false);
          return;
        }
      } catch {
        // Fall through to the server pin below.
      }
      if (cancelled) return;
      try {
        const payload = await fetchTrackMeta(videoId, {
          provider: pinnedProvider,
          order: lyricsProviderOrder,
          enabled: lyricsProvidersEnabled,
          ...(paxsenixApiKey ? { paxsenixKey: paxsenixApiKey } : {}),
        });
        if (cancelled) return;
        setPinnedLyrics(payload?.lyrics ?? null);
      } catch {
        if (cancelled) return;
        setPinnedLyrics(null);
      }
      if (!cancelled) setPinnedLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // `current` is intentionally read, not depended on: the pin is
    // re-fetched on song/provider/settings change, not on every
    // player-state tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedProvider, videoId, lyricsProviderOrder, lyricsProvidersEnabled, paxsenixApiKey, track?.title, track?.artist, track?.album, track?.durationSeconds]);

  // Background client best-match: run the same chain the picker uses
  // (same order/enabled/key, aborted on song change) and replace the
  // server lyrics ONLY when the client quality is strictly greater
  // than the server's (or the server has none). Equal quality keeps
  // the server result, so nothing flickers. The server translate
  // path and PlayerContext's metadata fetch are untouched.
  useEffect(() => {
    if (!videoId) return undefined;
    let cancelled = false;
    fetchClientBestLyrics(
      {
        videoId,
        title: track?.title ?? current?.title,
        artist: track?.artist ?? current?.artist,
        album: track?.album,
        durationSeconds: track?.durationSeconds ?? current?.durationSeconds ?? undefined,
        order: lyricsProviderOrder,
        enabled: lyricsProvidersEnabled,
        ...(paxsenixApiKey ? { paxsenixKey: paxsenixApiKey } : {}),
      },
    )
      .then((best) => {
        if (cancelled || !best) return;
        setClientLyrics({
          synced: best.synced,
          unsynced: best.unsynced,
          source: best.name,
          provider: best.provider,
        });
      })
      .catch(() => {
        // Client chain unavailable: the server lyrics stand.
      });
    return () => {
      cancelled = true;
    };
    // `current` is read, not depended on, for the same reason as the pin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, lyricsProviderOrder, lyricsProvidersEnabled, paxsenixApiKey, track?.title, track?.artist, track?.album, track?.durationSeconds]);

  const serverQuality = inferLyricsQuality(synced, unsynced);
  const clientQuality = clientLyrics
    ? inferLyricsQuality(clientLyrics.synced, clientLyrics.unsynced)
    : -1;
  const useClientLyrics =
    !pinnedProvider && clientLyrics != null && (serverQuality === -1 || clientQuality > serverQuality);
  const effectiveSynced = pinnedProvider ? pinnedLyrics?.synced : useClientLyrics ? clientLyrics?.synced : synced;
  const effectiveUnsynced = pinnedProvider
    ? pinnedLyrics?.unsynced
    : useClientLyrics
      ? clientLyrics?.unsynced
      : unsynced;
  const effectiveSource = pinnedProvider ? pinnedLyrics?.source : useClientLyrics ? clientLyrics?.source : source;
  const effectiveProvider = pinnedProvider
    ? (pinnedLyrics?.provider ?? pinnedProvider)
    : useClientLyrics
      ? (clientLyrics?.provider ?? provider)
      : provider;

  /** Defensive copy of the payload lines (bad timestamps become `0`), in
   *  timestamp order — the engine's binary search depends on it. Every
   *  extended field the server carries (words, translation,
   *  romanization, instrumental breaks, agents) rides along untouched. */
  const lines = useMemo<LyricLine[]>(() => {
    if (!Array.isArray(effectiveSynced)) return [];
    return (
      effectiveSynced
        .map((line) => ({
          timeMs: Number(line?.timeMs) || 0,
          endTimeMs: line?.endTimeMs,
          // an embedded newline would split a row's layout, so flatten breaks first
          text: String(line?.text ?? '')
            .replace(/[\r\n]+/g, ' ')
            .trim(),
          words: line?.words,
          translation: line?.translation,
          romanizedText: line?.romanizedText,
          romanizedWords: line?.romanizedWords,
          isInstrumental: line?.isInstrumental,
          agent: line?.agent,
          durationMs: line?.durationMs,
        }))
        // stable sort: sorted payloads (the normal case) keep their order
        .sort((a, b) => a.timeMs - b.timeMs)
    );
  }, [effectiveSynced]);

  const hasSynced = lines.length > 0;
  const stillLoading = (loading || pinnedLoading) && !timedOut;

  // Metadata that never arrives (offline, provider down) must not spin
  // forever — after the deadline the panel reports the song as lyricless.
  useEffect(() => {
    if (!loading && !pinnedLoading) {
      setTimedOut(false);
      return undefined;
    }
    const timer = setTimeout(() => setTimedOut(true), LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [loading, pinnedLoading]);

  // A plain-text page always opens at the first verse.
  useEffect(() => {
    if (hasSynced) return;
    scrollRef.current?.scrollTo({ top: 0 });
  }, [effectiveUnsynced, hasSynced]);

  const providerName = effectiveProvider ? lyricsChainLabel(effectiveProvider) : null;
  const chipLabel =
    providerName && effectiveSource && effectiveSource !== providerName
      ? `${providerName} · ${effectiveSource}`
      : (providerName ?? effectiveSource ?? null);
  const canPick = Boolean(videoId);

  const chip = chipLabel ? (
    <div className="flex shrink-0 justify-center px-4 pb-1 pt-1">
      <button
        type="button"
        disabled={!canPick}
        onClick={() => setPickerOpen(true)}
        title={canPick ? 'Choose lyrics provider' : undefined}
        className={cn(
          'rounded-full border border-line bg-surface/60 px-3 py-1 text-xs font-semibold leading-[1.4] text-muted shadow-glass transition focus-visible:outline-2 focus-visible:outline-accent',
          canPick && 'cursor-pointer hover:brightness-125 hover:text-body active:scale-[0.96]',
          pinnedProvider && 'border-accent/50 text-accent-fg',
        )}
      >
        {chipLabel}
        {pinnedProvider ? ' · pinned' : ''}
      </button>
    </div>
  ) : null;

  const picker = canPick ? (
    <LyricsProviderPicker
      open={pickerOpen}
      onClose={() => setPickerOpen(false)}
      videoId={videoId!}
      title={track?.title ?? current?.title}
      artist={track?.artist ?? current?.artist}
      album={track?.album}
      durationSeconds={track?.durationSeconds ?? current?.durationSeconds ?? undefined}
      currentProviderId={effectiveProvider ?? null}
      pinnedProviderId={pinnedProvider}
      onSelect={(providerId) => {
        setPinnedProvider(providerId);
        setPinnedLyrics(null);
        setPickerOpen(false);
      }}
    />
  ) : null;

  // ── Loading ────────────────────────────────────────────────────────────
  if (stillLoading && !hasSynced) {
    return (
      <div
        aria-busy
        aria-live="polite"
        className="flex h-full flex-col items-center gap-3 px-6 py-3"
      >
        {[70, 92, 58, 84, 66, 78].map((width, index) => (
          <Shimmer
            key={width}
            variant="rounded"
            width={`${width}%`}
            height={24}
            style={{ opacity: 1 - index * 0.12 }}
          />
        ))}
        <span className="text-xs leading-[1.4] text-disabled">
          Finding lyrics…
        </span>
      </div>
    );
  }

  // ── Nothing to sing along to ───────────────────────────────────────────
  if (!hasSynced && !effectiveUnsynced) {
    return (
      <div aria-live="polite" className="grid h-full place-items-center px-6 py-12">
        <div className="text-center">
          <p className="m-0 text-base font-semibold text-muted">
            Lyrics not available yet
          </p>
          <span className="text-xs leading-[1.4] text-disabled">
            {current?.title}
          </span>
        </div>
        {picker}
      </div>
    );
  }

  // ── Unsynced fallback: plain page, pinned to the top ───────────────────
  if (!hasSynced) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {chip}
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
          style={{
            maskImage:
              'linear-gradient(to bottom, transparent, black 6%, black 92%, transparent)',
            WebkitMaskImage:
              'linear-gradient(to bottom, transparent, black 6%, black 92%, transparent)',
          }}
        >
          <style>{LYRICS_FADE_KEYFRAMES}</style>
          <p
            className="m-0 whitespace-pre-line text-center text-base leading-[1.5] text-muted"
            style={{
              lineHeight: 2,
              fontSize: unsyncedFontSize,
              animation: 'lyrics-fade 500ms ease',
            }}
          >
            {effectiveUnsynced}
          </p>
        </div>
        {picker}
      </div>
    );
  }

  // ── Synced karaoke view ────────────────────────────────────────────────
  return (
    <div className="flex h-full min-h-0 flex-col">
      {chip}
      <SyncedLyrics lines={lines} onSeek={seek} />
      {picker}
    </div>
  );
}
