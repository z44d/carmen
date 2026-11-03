import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { usePlayhead } from '../player/PlayerContext';
import { useSettings } from '../settings/store';
import { useTheme } from '../theme/ThemeContext';
import type { LyricLine, LyricWord, LyricsSize } from '../types/models';
import { cn } from '../utils/cn';
import { activeLineIndexAt as activeIndexAt, isRtlText, karaokeWordsOf } from '../utils/lyrics';
import { MusicNoteIcon } from './icons';

/**
 * Synced lyrics engine — rAF glide + windowed rows, zero renders per tick.
 *
 * **How a tick moves through here.**  A `PlayheadProbe` child subscribes to
 * the playhead context and forwards the seconds into this component, which
 * keeps *everything* in refs: the active line is a binary search over the
 * timestamps, and React state only updates when the **line index actually
 * changes**.  The list therefore never re-renders because time passed — the
 * per-tick cost is one `O(log n)` search.  On a line change, only the rows
 * whose `active`/`past` flags flipped repaint; every other row is a
 * `React.memo` bail-out.
 *
 * **How the view follows.**  The container is a native scroller (wheel,
 * trackpad, touch, scrollbar and keyboard all keep working) whose visible
 * rows are absolutely positioned with `transform: translateY(...)` inside a
 * total-height spacer — no layout, hardware-composited, windowed by
 * `@tanstack/react-virtual` so a 500-line song still paints a dozen nodes.
 * A `requestAnimationFrame` loop eases `scrollTop` toward the centred
 * offset of the active line and **stops itself** once it arrives (or the
 * reader takes over), so idle CPU is exactly zero — no perpetual frame
 * loop, no `timeupdate`-driven DOM writes.
 *
 * **Reader control.**  Any scroll that is not our own write — wheel,
 * touch drag, scrollbar, keyboard — suspends the follow for
 * `RESUME_FOLLOW_MS`; a tapped line seeks the song *and* resumes the
 * follow immediately (the tap is the decision).  Resizes re-centre.
 *
 * The row chrome (accent highlight, scale, past-line dimming, focus ring,
 * tap-keeps-its-hover) is unchanged from the previous react-lrc renderer.
 */

/** How long the reader's own scrolling pauses the follow (ms). */
const RESUME_FOLLOW_MS = 2500;
/** Glide weight per frame — arrives quickly, still eases into place. */
const FOLLOW_EASE = 0.16;
/** Distance from the target (px) at which the glide counts as arrived. */
const FOLLOW_EPSILON = 0.5;
/** Scroll deltas of 2px or less are our own write rounding, not the user. */
const OWN_SCROLL_TOLERANCE = 2;
/** Extra rows rendered above/below the viewport. */
const OVERSCAN = 6;
/** Row height guess before the first measurement (px) — refines itself. */
const ESTIMATED_ROW = 52;

/**
 * Row font size per Settings → Lyrics size. `default` keeps the old
 * responsive ladder (a hair larger on desktop); the explicit steps scale
 * both ends together. Tailwind scans literal class strings, so the sizes
 * live here as complete utilities, not interpolations.
 */
const LYRICS_TEXT: Record<LyricsSize, string> = {
  default: 'text-[1.1rem] md:text-[1.15rem]',
  large: 'text-[1.32rem] md:text-[1.38rem]',
  veryLarge: 'text-[1.58rem] md:text-[1.66rem]',
};

/** Supplementary (romanization / translation) size — 0.55× the line size. */
const SUPPLEMENTARY_TEXT: Record<LyricsSize, string> = {
  default: 'text-[0.62rem] md:text-[0.65rem]',
  large: 'text-[0.74rem] md:text-[0.78rem]',
  veryLarge: 'text-[0.88rem] md:text-[0.93rem]',
};

/**
 * Distance-based dimming, ported from Android's LyricsV2: the neighbour
 * lines stay readable, lines further away fade toward the background,
 * and past lines fade exactly like future ones at the same distance.
 * `-1` means no active line yet (intro) — everything stays readable.
 */
function opacityForDistance(distance: number): number {
  if (distance < 0) return 0.7;
  if (distance === 0) return 1;
  if (distance === 1) return 0.52;
  if (distance === 2) return 0.3;
  if (distance === 3) return 0.18;
  return 0.1;
}

/**
 * The engine's playhead subscriber: it forwards each tick and renders
 * nothing at all, so the engine above stays render-free between lines.
 * (The only other subscriber is the karaoke leaf below — one active row.)
 */
function PlayheadProbe({ onTick }: { onTick: (seconds: number) => void }) {
  const { currentTime } = usePlayhead();
  useEffect(() => {
    onTick(currentTime);
  }, [currentTime, onTick]);
  return null;
}

/**
 * Word-by-word karaoke inside the active line — the one component allowed
 * to repaint per playhead tick: it re-reads the clock and colours the words
 * the playhead has passed. Only this leaf re-renders (a handful of spans at
 * the tick rate); its row stays memoised and the engine above stays
 * render-free between lines.
 */
function KaraokeWords({ words, accentFg }: { words: LyricWord[]; accentFg: string }) {
  const { currentTime } = usePlayhead();
  const nowMs = currentTime * 1000;
  return (
    <>
      {words.map((word, index) => {
        const sung = nowMs >= word.startMs;
        return (
          <span
            key={`${word.startMs}-${index}`}
            style={{
              color: sung ? accentFg : undefined,
              opacity: sung ? 1 : 0.55,
              transition: 'color 160ms ease, opacity 160ms ease',
            }}
          >
            {word.text}
            {index + 1 < words.length ? ' ' : ''}
          </span>
        );
      })}
    </>
  );
}

/**
 * Words of a line that has already been sung — static, no playhead
 * subscription: every word wears the accent, exactly as the karaoke
 * leaf leaves them once the playhead has passed. Only the active row
 * subscribes (see `KaraokeWords`); past rows repaint only when the
 * active line moves, so the engine's zero-renders-per-tick promise
 * holds for every other row.
 */
function SungWords({ words, accentFg }: { words: LyricWord[]; accentFg: string }) {
  return (
    <>
      {words.map((word, index) => (
        <span key={`${word.startMs}-${index}`} style={{ color: accentFg }}>
          {word.text}
          {index + 1 < words.length ? ' ' : ''}
        </span>
      ))}
    </>
  );
}

interface SyncedLyricsProps {
  /** Timestamped lines of the playing song (never empty — checked by caller). */
  lines: LyricLine[];
  /** Seek the song to a line's timestamp (seconds). */
  onSeek: (seconds: number) => void;
}

/**
 * One lyric line.  Memoised: a playhead tick, a scroll frame or a
 * neighbouring highlight leaves it untouched — it repaints only when its
 * own `active`/`distance` flags change, which is the whole point of the
 * engine.
 *
 * Rendering follows Android's LyricsV2: centred lines (agent `v2` lines
 * end-aligned, explicit `v1` lines start-aligned), the active line
 * larger/bolder with word-by-word highlight when word stamps exist,
 * provider romanization above the line and translation below it at
 * 0.55× size, background vocals on their own smaller row, RTL lines
 * rendered `dir="auto"` and right-aligned, and instrumental breaks as a
 * distinct centred music-note row.
 */
const LyricRow = memo(function LyricRow({
  line,
  active,
  past,
  distance,
  accentFg,
  onSelect,
  textClass,
  supplementaryClass,
  karaoke,
  nextStartMs,
}: {
  line: LyricLine;
  active: boolean;
  past: boolean;
  /** Lines away from the active line (`-1` = no active line yet). */
  distance: number;
  accentFg: string;
  onSelect: (timeMs: number) => void;
  /** Font-size utility from `LYRICS_TEXT`, decided by the parent once. */
  textClass: string;
  /** Font-size utility from `SUPPLEMENTARY_TEXT`, decided by the parent once. */
  supplementaryClass: string;
  /** Word-by-word karaoke on (Settings → Word-by-word karaoke). */
  karaoke: boolean;
  /** The next line's timestamp — the end boundary for estimated word slots. */
  nextStartMs: number | undefined;
}) {
  const handleClick = useCallback(() => onSelect(line.timeMs), [onSelect, line.timeMs]);
  // Derived once per line change, never per tick — the karaoke leaf below
  // only *reads* the clock against these stamps.
  const timedWords = useMemo(
    () => (karaoke ? karaokeWordsOf(line, nextStartMs) : null),
    [karaoke, line, nextStartMs],
  );
  // Main vs background vocals split exactly as Android splits them:
  // background words ride their own smaller row under the main line.
  const mainWords = useMemo(
    () => timedWords?.filter((word) => !word.isBackground) ?? null,
    [timedWords],
  );
  const backgroundWords = useMemo(() => {
    if (timedWords) return timedWords.filter((word) => word.isBackground);
    return line.words?.filter((word) => word.isBackground) ?? [];
  }, [timedWords, line.words]);
  const hasMainWords = (mainWords?.length ?? 0) > 0;

  const romanized =
    line.romanizedText?.trim() ||
    (line.romanizedWords?.length ? line.romanizedWords.join(' ').trim() : '') ||
    undefined;
  const translation = line.translation?.trim() || undefined;
  const displayText = line.text || '';
  const rtl = isRtlText(displayText || romanized || '');
  // Agent alignment (Android): `v2` → end, explicit `v1` → start,
  // anything else (incl. no agent) → centred. RTL lines right-align.
  const agent = line.agent?.toLowerCase();
  const align = rtl ? 'right' : agent === 'v2' ? 'right' : agent === 'v1' ? 'left' : 'center';
  const isAllBackground =
    (line.words?.length ?? 0) > 0 && line.words?.every((word) => word.isBackground || !word.text.trim());

  if (line.isInstrumental) {
    return (
      <button
        type="button"
        aria-current={active || undefined}
        aria-label="Instrumental break"
        onClick={handleClick}
        className={cn(
          'm-0 block w-full cursor-pointer rounded-[28px] border-none bg-transparent p-[10px]',
          'text-center text-body',
          '[&:focus:not(:focus-visible)]:outline-none focus-visible:outline-offset-2 focus-visible:[outline:2px_solid_var(--lyric-ring)]',
        )}
        style={
          {
            lineHeight: 1.8,
            color: active ? accentFg : undefined,
            opacity: opacityForDistance(distance),
            transform: active ? 'scale(1.05)' : 'scale(1)',
            transformOrigin: 'center',
            transition:
              'color 200ms ease, opacity 200ms ease, transform 240ms cubic-bezier(.2,.8,.2,1)',
            '--lyric-ring': accentFg,
          } as CSSProperties
        }
      >
        <span className="inline-flex items-center gap-2">
          <MusicNoteIcon className={active ? undefined : 'opacity-70'} />
          <span className="text-sm font-semibold tracking-wide">Instrumental</span>
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      aria-current={active || undefined}
      onClick={handleClick}
      dir="auto"
      className={cn(
        'm-0 block w-full cursor-pointer rounded-[28px] border-none bg-transparent p-[10px]',
        'text-body',
        textClass,
        align === 'right' ? 'text-right' : align === 'left' ? 'text-left' : 'text-center',
        // a line the reader tapped keeps :hover (and focus) on touch
        // screens — the highlight has to follow the song, not the
        // finger, so only focus-visible still draws a ring
        '[&:focus:not(:focus-visible)]:outline-none focus-visible:outline-offset-2 focus-visible:[outline:2px_solid_var(--lyric-ring)]',
      )}
      style={
        {
          fontFamily: 'inherit',
          // unitless line height: every row keeps the same height even
          // as the active line changes weight — nothing reflows mid-song
          lineHeight: 1.8,
          fontWeight: active ? 700 : 600,
          fontStyle: isAllBackground ? 'italic' : undefined,
          color: active ? accentFg : undefined,
          opacity: opacityForDistance(distance),
          // a transform never touches layout, so the highlight cannot
          // shift the lines around it while the song plays
          transform: active ? 'scale(1.05)' : 'scale(1)',
          transformOrigin: 'center',
          transition:
            'color 200ms ease, opacity 200ms ease, transform 240ms cubic-bezier(.2,.8,.2,1)',
          '--lyric-ring': accentFg,
        } as CSSProperties
      }
    >
      {romanized && (
        <span
          className={cn('mb-1 block font-normal', supplementaryClass)}
          style={{ opacity: active ? 0.76 : 0.42 }}
        >
          {romanized}
        </span>
      )}
      {hasMainWords ? (
        active ? (
          <KaraokeWords words={mainWords!} accentFg={accentFg} />
        ) : past ? (
          <SungWords words={mainWords!} accentFg={accentFg} />
        ) : (
          displayText || '♪'
        )
      ) : backgroundWords.length ? null : (
        displayText || '♪'
      )}
      {backgroundWords.length > 0 && (
        <span
          className="mt-1 block font-normal italic"
          style={{ fontSize: '0.65em', opacity: 0.85 }}
        >
          {karaoke ? (
            active ? (
              <KaraokeWords words={backgroundWords} accentFg={accentFg} />
            ) : past ? (
              <SungWords words={backgroundWords} accentFg={accentFg} />
            ) : (
              backgroundWords.map((word) => word.text).join('')
            )
          ) : (
            backgroundWords.map((word) => word.text).join('')
          )}
        </span>
      )}
      {translation && (
        <span
          className={cn('mt-1 block font-normal', supplementaryClass)}
          style={{ opacity: active ? 0.76 : 0.42 }}
        >
          {translation}
        </span>
      )}
    </button>
  );
});

export default function SyncedLyrics({ lines, onSeek }: SyncedLyricsProps) {
  const { accentFg } = useTheme();
  const { lyricsSize, karaokeWords } = useSettings();

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  /** React mirror of the active line — the only state a tick can change. */
  const [activeIdx, setActiveIdx] = useState(-1);
  /** The reader took over scrolling — the follow is parked (Resume shows). */
  const [suspended, setSuspended] = useState(false);

  // Latest-ref pattern: child effects (the probe) run before this component's
  // own, so the payload must be readable during render, not in an effect.
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const activeIdxRef = useRef(-1);
  const lastTickRef = useRef(0);
  const suspendedRef = useRef(false);
  const resumeTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const targetRef = useRef(0);
  const authoredTopRef = useRef(0);
  /** Publishes the freshest target computation to the stable callbacks. */
  const computeTargetRef = useRef<(idx: number) => number>(() => 0);

  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => ESTIMATED_ROW,
    overscan: OVERSCAN,
    // Room under the last line so it can still travel to the middle of the
    // viewport — the virtual equivalent of the old `pb: 30vh`.
    paddingEnd: (scrollerRef.current?.clientHeight ?? 480) * 0.4,
  });

  /** Centred scroll offset for a line, clamped to what the box can show. */
  const computeTarget = useCallback(
    (idx: number): number => {
      const element = scrollerRef.current;
      if (!element || idx < 0) return 0;
      const info = virtualizer.getOffsetForIndex(idx, 'center');
      const offset = info?.[0] ?? idx * ESTIMATED_ROW;
      const max = Math.max(0, element.scrollHeight - element.clientHeight);
      return Math.min(Math.max(offset, 0), max);
    },
    [virtualizer],
  );
  computeTargetRef.current = computeTarget;

  /** One eased frame; stops itself on arrival, suspension or unmount. */
  const step = useCallback(() => {
    rafRef.current = null;
    const element = scrollerRef.current;
    if (!element || suspendedRef.current) return;
    const delta = targetRef.current - element.scrollTop;
    if (Math.abs(delta) < FOLLOW_EPSILON) return;
    const max = Math.max(0, element.scrollHeight - element.clientHeight);
    const next = Math.min(element.scrollTop + delta * FOLLOW_EASE, max);
    // A target past the box's end (a near-final line that cannot reach the
    // centre) settles here — the browser would clamp the write and the
    // mismatch would spin the loop forever.
    if (Math.abs(next - element.scrollTop) < FOLLOW_EPSILON) return;
    authoredTopRef.current = next;
    element.scrollTop = next;
    rafRef.current = requestAnimationFrame(step);
  }, []);

  const startGlide = useCallback(() => {
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(step);
  }, [step]);

  const glideToActive = useCallback(() => {
    targetRef.current = computeTargetRef.current(activeIdxRef.current);
    startGlide();
  }, [startGlide]);

  /** Reader took over: stop following, come back after the grace period. */
  const suspend = useCallback(() => {
    suspendedRef.current = true;
    setSuspended(true);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (resumeTimerRef.current !== null) window.clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = window.setTimeout(() => {
      resumeTimerRef.current = null;
      suspendedRef.current = false;
      setSuspended(false);
      glideToActive();
    }, RESUME_FOLLOW_MS);
  }, [glideToActive]);

  /** The reader asked to follow again right now (Resume button / tap). */
  const resumeFollow = useCallback(() => {
    suspendedRef.current = false;
    setSuspended(false);
    if (resumeTimerRef.current !== null) {
      window.clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
    glideToActive();
  }, [glideToActive]);

  /** The single funnel: a playhead tick or a payload change lands here. */
  const syncTo = useCallback(
    (timeMs: number) => {
      const idx = activeIndexAt(linesRef.current, Math.max(0, timeMs));
      if (idx === activeIdxRef.current) {
        // Index unchanged — but a glide may have been cancelled out from
        // under us (StrictMode's second mount passes run after the cleanup).
        // If no frame is pending and the view is not on target, re-arm.
        const element = scrollerRef.current;
        if (
          !suspendedRef.current &&
          rafRef.current === null &&
          element &&
          Math.abs(targetRef.current - element.scrollTop) > FOLLOW_EPSILON
        ) {
          glideToActive();
        }
        return;
      }
      activeIdxRef.current = idx;
      setActiveIdx(idx); // the only render a line change costs
      if (!suspendedRef.current) glideToActive();
    },
    [glideToActive],
  );

  const handleTick = useCallback(
    (seconds: number) => {
      lastTickRef.current = seconds;
      syncTo(seconds * 1000);
    },
    [syncTo],
  );

  // Lines can arrive *after* the playhead stood still (a late lyrics fetch,
  // a track switched while paused) — re-derive the active line whenever the
  // payload changes, not only when time moves.
  useEffect(() => {
    syncTo(lastTickRef.current * 1000);
  }, [lines, syncTo]);

  // Detect scrolls we did not author (wheel, drag, keyboard, momentum) and
  // park the follow for the grace period.
  const handleScroll = useCallback(() => {
    const element = scrollerRef.current;
    if (!element) return;
    if (Math.abs(element.scrollTop - authoredTopRef.current) <= OWN_SCROLL_TOLERANCE) return;
    suspend();
  }, [suspend]);

  // Wheel/touch also suspend when they move nothing (a nudge at the very
  // top) — the intent to scroll is the same either way.
  const handleManualScroll = useCallback(() => suspend(), [suspend]);

  const handleSelect = useCallback(
    (timeMs: number) => {
      // The tap *is* the decision: cancel the suspension, seek, and glide to
      // the line right now — even when it is the line already playing.
      suspendedRef.current = false;
      setSuspended(false);
      if (resumeTimerRef.current !== null) {
        window.clearTimeout(resumeTimerRef.current);
        resumeTimerRef.current = null;
      }
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      onSeek(timeMs / 1000);
      syncTo(timeMs); // index may not even change (tapping the current line)
      glideToActive();
    },
    [onSeek, syncTo, glideToActive],
  );

  // Listener + lifetime wiring.
  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return undefined;
    element.addEventListener('scroll', handleScroll, { passive: true });
    element.addEventListener('wheel', handleManualScroll, { passive: true });
    element.addEventListener('touchmove', handleManualScroll, { passive: true });
    return () => {
      element.removeEventListener('scroll', handleScroll);
      element.removeEventListener('wheel', handleManualScroll);
      element.removeEventListener('touchmove', handleManualScroll);
    };
  }, [handleScroll, handleManualScroll]);

  // A taller/shorter box moves the centre line — re-target on resize.
  useEffect(() => {
    const element = scrollerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (!suspendedRef.current) glideToActive();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [glideToActive]);

  useEffect(
    () => () => {
      // Null the refs after cancelling: `rafRef non-null` must mean "a frame
      // is pending", or `startGlide`'s guard refuses to schedule ever again.
      // (StrictMode's mount/unmount pass runs this cleanup while the same
      // instance is reused — a stale id here used to kill the follow for
      // good, which is why opening lyrics mid-song never scrolled.)
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (resumeTimerRef.current !== null) {
        window.clearTimeout(resumeTimerRef.current);
        resumeTimerRef.current = null;
      }
    },
    [],
  );

  const rows = virtualizer.getVirtualItems();

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <PlayheadProbe onTick={handleTick} />
      {/* `translateZ(0)` + will-change promote the scroller to its own
          compositor layer, so the eased scrollTop and the transform-positioned
          rows never wait on style/layout work (spec: hardware acceleration). */}
      <div
        ref={scrollerRef}
        className="relative min-h-0 flex-1 overflow-y-auto px-2 py-2 will-change-transform sm:px-3 [transform:translateZ(0)]"
        style={{
          // room below the last line so it can still travel to the middle
          paddingBottom: '30vh',
          // the head and tail of the viewport fade instead of cutting off
          maskImage:
            'linear-gradient(to bottom, transparent 0, black 32px, black calc(100% - 96px), transparent 100%)',
          WebkitMaskImage:
            'linear-gradient(to bottom, transparent 0, black 32px, black calc(100% - 96px), transparent 100%)',
        }}
      >
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {rows.map((row) => {
            const line = lines[row.index];
            if (!line) return null;
            return (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full will-change-transform"
                style={{
                  // windowed rows are positioned on the compositor only
                  transform: `translateY(${row.start}px)`,
                }}
              >
                <LyricRow
                  line={line}
                  active={row.index === activeIdx}
                  past={row.index < activeIdx}
                  distance={activeIdx < 0 ? -1 : Math.abs(row.index - activeIdx)}
                  accentFg={accentFg}
                  onSelect={handleSelect}
                  textClass={LYRICS_TEXT[lyricsSize]}
                  supplementaryClass={SUPPLEMENTARY_TEXT[lyricsSize]}
                  karaoke={karaokeWords}
                  nextStartMs={lines[row.index + 1]?.timeMs}
                />
              </div>
            );
          })}
        </div>
      </div>
      {/* The reader scrolled away — one tap returns to the sung line. */}
      {suspended && activeIdx >= 0 && (
        <button
          type="button"
          onClick={resumeFollow}
          className="glass-pill absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full px-4 py-1.5 text-sm font-semibold text-body shadow-glass transition hover:brightness-125 active:scale-[0.96]"
        >
          Resume
        </button>
      )}
    </div>
  );
}
