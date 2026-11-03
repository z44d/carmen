import { useRef, useState } from 'react';

import { ProgressBar } from '../components/ui';
import { useEffectsEnabled } from '../settings/store';
import { usePlayhead } from '../player/PlayerContext';
import { alpha } from '../utils/color';
import { cn } from '../utils/cn';
import { formatTime } from '../utils/format';

interface NPScrubberProps {
  onSeek: (seconds: number) => void;
}

/** Slider step: the bar moves in half-second increments, like before. */
const STEP = 0.5;

/**
 * Seek bar of the now-playing screen.
 *
 * A hairline rail that fattens under the pointer, the buffered range in a
 * muted tint and a neutral body-colour fill — the thumb is always visible
 * (iPhone style), slightly larger on touch. While a gesture is in flight
 * the bar keeps a *tentative* position in local state, so it never snaps
 * back to the real playhead under the finger; the seek is only sent when
 * the gesture commits. Keyboard changes (arrow / page / home / end keys)
 * commit right away too, so the bar stays fully keyboard operable.
 *
 * MIGRATION: MUI's `Slider` became a hand-built `role="slider"` div —
 * same pointer flow (press → drag → release commits, `step` rounding,
 * press-time focus) and the same keyboard contract: arrows ±`STEP`,
 * PageUp/PageDown ±10% of the duration, Home/End jump to the ends, and
 * every handled key commits through `onSeek`.
 */
export default function NPScrubber({ onSeek }: NPScrubberProps) {
  // The playhead lives in its own context (`usePlayhead`), so these
  // per-tick updates repaint just this bar — never the whole player.
  // `duration` is already metadata-preferred (see PlayerContext): it trusts
  // `/browsing/track`'s `duration_seconds`, not the possibly-untrustworthy
  // duration the audio element parses out of the m4a container.
  const { currentTime, duration, buffered } = usePlayhead();
  const [scrub, setScrub] = useState<number | null>(null);
  // The fill's soft shadow is a painted effect — flat while high
  // performance mode is on.
  const effectsEnabled = useEffectsEnabled();

  const sliderRef = useRef<HTMLDivElement>(null);
  // Mirrors MUI's press → drag → release cycle: the value under the finger
  // is tentative (`scrub`) until the pointer is released.
  const pressedRef = useRef(false);
  const moveCountRef = useRef(0);
  // The track stops easing towards the finger once the drag is intentional,
  // so the fill stays glued to the pointer (MUI's `dragging` state).
  const [dragging, setDragging] = useState(false);

  const progress = duration ? Math.min(Math.max(scrub ?? currentTime, 0), duration) : 0;
  const bufferedFraction = duration ? Math.min(Math.max(buffered, 0) / duration, 1) : 0;
  const elapsed = scrub ?? currentTime;
  const progressPercent = duration ? (progress / duration) * 100 : 0;

  /** Position → slider value, rounded to `step` and clamped to the range. */
  const valueAt = (clientX: number): number | null => {
    const rect = sliderRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !duration) return null;
    const fraction = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    const rounded = Math.round((fraction * duration) / STEP) * STEP;
    return Math.min(Math.max(rounded, 0), duration);
  };

  const commit = (value: number | null) => {
    if (value != null) onSeek(value);
    setScrub(null);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // MUI's root did the same: no text selection while the finger moves.
    event.preventDefault();
    // MUI focused its hidden input on press — keep the bar focusable so the
    // keyboard contract is one gesture away.
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    pressedRef.current = true;
    moveCountRef.current = 0;
    setScrub(valueAt(event.clientX));
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pressedRef.current) return;
    moveCountRef.current += 1;
    if (moveCountRef.current > 2) setDragging(true);
    setScrub(valueAt(event.clientX));
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pressedRef.current) return;
    pressedRef.current = false;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    commit(scrub);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const bigIncrement = duration / 10;
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        next = progress + STEP;
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        next = progress - STEP;
        break;
      case 'PageUp':
        next = progress + bigIncrement;
        break;
      case 'PageDown':
        next = progress - bigIncrement;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = duration;
        break;
      default:
        return;
    }
    event.preventDefault();
    commit(Math.min(Math.max(next, 0), duration));
  };

  return (
    <div className="mt-5">
      <div className="group relative">
        {/* empty rail */}
        <div
          aria-hidden
          className="seek-rail pointer-events-none absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-[42px] bg-hover [transition:height_140ms_ease] pointer-coarse:h-1.5 group-hover:h-1.5 group-focus-within:h-1.5"
        />
        {/* buffered range, painted behind the thumb */}
        <div
          aria-hidden
          className="seek-buffer pointer-events-none absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-[42px] pointer-coarse:h-1.5 group-hover:h-1.5 group-focus-within:h-1.5"
          style={{
            width: `${bufferedFraction * 100}%`,
            backgroundColor: alpha('var(--app-text)', 0.16),
            transition: 'width 300ms linear, height 140ms ease',
          }}
        />
        {duration ? (
          <div
            ref={sliderRef}
            role="slider"
            tabIndex={0}
            aria-label="Seek"
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={progress}
            className="relative block h-4 w-full cursor-pointer touch-none select-none"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onKeyDown={handleKeyDown}
          >
            {/* played range — the neutral body-colour fill */}
            <div
              aria-hidden
              className={cn(
                'seek-fill pointer-events-none absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-[42px] bg-body pointer-coarse:h-1.5',
                !dragging && '[transition:width_150ms_cubic-bezier(0.4,0,0.2,1)]',
              )}
              style={{
                width: `${progressPercent}%`,
                boxShadow: effectsEnabled
                  ? `0 0 10px ${alpha('var(--app-text)', 0.35)}`
                  : 'none',
              }}
            />
            {/* thumb: 14px body-colour dot, always visible, larger on touch */}
            <div
              aria-hidden
              className="seek-thumb pointer-events-none absolute top-1/2 size-[14px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-body shadow-[0_1px_6px_rgba(0,0,0,0.45)]"
              style={{ left: `${progressPercent}%` }}
            />
          </div>
        ) : (
          /* no duration yet: the indeterminate bar says "loading" instead of
             pretending the song is one pixel long */
          <ProgressBar />
        )}
      </div>
      <div className="mt-[2px] flex justify-between">
        <span className="text-xs leading-[1.4] text-muted tabular-nums">
          {formatTime(elapsed)}
        </span>
        <span className="text-xs leading-[1.4] text-muted tabular-nums">
          {duration ? formatTime(duration) : '--:--'}
        </span>
      </div>
    </div>
  );
}
