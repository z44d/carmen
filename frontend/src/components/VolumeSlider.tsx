import { useRef, useState } from 'react';

import { usePlayer } from '../player/PlayerContext';
import { cn } from '../utils/cn';
import { VolumeDownIcon, VolumeOffIcon, VolumeUpIcon } from './icons';

/** Keyboard step for the volume slider (5% per arrow press). */
const STEP = 0.05;

/**
 * iPhone-style volume row: quiet speaker, slider, loud speaker.
 *
 * Real control — it writes the player context's `volume`, which the
 * provider applies to the single `<audio>` element (and persists). The
 * interaction mirrors the seek bar's: press → drag → release commits
 * continuously (volume has no "tentative" state worth keeping), arrows
 * move 5%, PageUp/PageDown 20%, Home/End jump to the ends. The speaker
 * button mutes and restores the last non-zero level.
 */
export default function VolumeSlider() {
  const { volume, setVolume } = usePlayer();
  const trackRef = useRef<HTMLDivElement>(null);
  const pressedRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const lastAudibleRef = useRef(volume > 0 ? volume : 1);

  if (volume > 0) lastAudibleRef.current = volume;

  const valueAt = (clientX: number): number | null => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return null;
    return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    pressedRef.current = true;
    setDragging(true);
    const value = valueAt(event.clientX);
    if (value != null) setVolume(value);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pressedRef.current) return;
    const value = valueAt(event.clientX);
    if (value != null) setVolume(value);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pressedRef.current) return;
    pressedRef.current = false;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        next = volume + STEP;
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        next = volume - STEP;
        break;
      case 'PageUp':
        next = volume + 0.2;
        break;
      case 'PageDown':
        next = volume - 0.2;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    setVolume(Math.min(Math.max(next, 0), 1));
  };

  const muted = volume === 0;
  const percent = Math.round(volume * 100);

  return (
    <div className="mx-auto flex w-full max-w-[440px] items-center gap-3" aria-label="Volume">
      <button
        type="button"
        aria-label={muted ? 'Unmute' : 'Mute'}
        aria-pressed={muted}
        onClick={() => setVolume(muted ? lastAudibleRef.current : 0)}
        className="grid size-10 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-hover hover:text-body focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.94]"
      >
        {muted ? <VolumeOffIcon fontSize="small" /> : <VolumeDownIcon fontSize="small" />}
      </button>
      <div className="group relative flex-1">
        <div
          aria-hidden
          className="pointer-events-none absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-hover"
        />
        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="Volume"
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${percent}%`}
          className="relative block h-6 w-full cursor-pointer touch-none select-none focus-visible:outline-2 focus-visible:outline-accent"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={handleKeyDown}
        >
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-body',
              !dragging && '[transition:width_120ms_ease]',
            )}
            style={{ width: `${percent}%` }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute top-1/2 size-[14px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-body shadow-[0_1px_6px_rgba(0,0,0,0.4)]"
            style={{ left: `${percent}%` }}
          />
        </div>
      </div>
      <VolumeUpIcon fontSize="small" className="shrink-0 text-muted" />
    </div>
  );
}
