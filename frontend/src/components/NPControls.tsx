import { Fab, IconButton, Spinner } from '../components/ui';

import { usePlayer } from '../player/PlayerContext';
import { useEffectsEnabled } from '../settings/store';
import { cn } from '../utils/cn';
import {
  PauseIcon,
  PlayArrowIcon,
  RepeatIcon,
  RepeatOneIcon,
  ShuffleIcon,
  SkipNextIcon,
  SkipPreviousIcon,
} from './icons';

/**
 * Transport row: shuffle · previous · play/pause · next · repeat.
 *
 * iPhone Music language: the transport is monochrome — shuffle/previous/
 * next/repeat in the body colour, and the play button is a large circle
 * filled with the body colour (white on dark, near-black on light) with a
 * contrasting icon and a soft neutral shadow. Shuffle and repeat keep
 * their accent tint while on, so the Settings accent still reads. The
 * button swaps to a spinner whenever the element is buffering — a stall
 * never looks like a frozen pause button.
 *
 * Repeat cycles `off → all → one` through `cycleRepeat`; the "one" state
 * wears the dedicated `RepeatOneIcon` so the mode is readable at a glance.
 *
 * `phone` widens the whole row for thumbs: shuffle/repeat spread to the
 * edges, the skips grow to 56px targets and the play circle to 74px — the
 * desktop metrics stay exactly as they were.
 */
export default function NPControls({ phone = false }: { phone?: boolean }) {
  const player = usePlayer();
  // The play circle's soft shadow is a painted effect — flat while low
  // battery mode is on.
  const effectsEnabled = useEffectsEnabled();
  // Shuffle / repeat icons are line art on the sheet — the `accent-fg`
  // tokens below are ThemeContext's readable accent, which keeps them
  // visible when the mode pins the accent to white.

  return (
    <div
      role="group"
      aria-label="Playback controls"
      className={cn(
        'mx-auto mt-3 flex w-full max-w-[440px] items-center',
        phone ? 'justify-between gap-1 px-1' : 'justify-center gap-[2px] sm:gap-[6px]',
      )}
    >
      <IconButton
        aria-label={player.shuffle ? 'Shuffle on' : 'Shuffle off'}
        aria-pressed={player.shuffle}
        onClick={player.toggleShuffle}
        className={cn(
          '![transition:background-color_160ms_ease,color_160ms_ease]',
          phone ? 'size-12' : 'size-11',
          player.shuffle
            ? '!bg-accent-fg/14 !text-accent-fg hover:!bg-accent-fg/22'
            : '!text-muted hover:!bg-[color-mix(in_srgb,var(--app-text)_8%,transparent)]',
        )}
      >
        <ShuffleIcon fontSize="small" />
      </IconButton>

      <IconButton
        aria-label="Previous"
        onClick={player.previous}
        className={cn('!text-body', phone ? 'size-14' : 'size-12')}
      >
        <SkipPreviousIcon sx={{ fontSize: phone ? 36 : 32 }} />
      </IconButton>

      <Fab
        aria-label={player.isPlaying ? 'Pause' : 'Play'}
        onClick={player.togglePlay}
        className={cn(
          phone ? 'mx-1 size-[74px]' : 'mx-2 size-[66px]',
          '!bg-body !text-bg',
          '![transition:transform_160ms_cubic-bezier(.2,.8,.2,1),box-shadow_160ms_ease]',
          'hover:[transform:scale(1.06)]',
          effectsEnabled &&
            'hover:![box-shadow:0_14px_32px_rgba(0,0,0,0.35)]',
        )}
        style={{
          boxShadow: effectsEnabled ? '0 10px 26px rgba(0,0,0,0.28)' : 'none',
        }}
      >
        {player.buffering ? (
          <Spinner size={phone ? 30 : 26} color="inherit" />
        ) : player.isPlaying ? (
          <PauseIcon sx={{ fontSize: phone ? 38 : 34 }} />
        ) : (
          <PlayArrowIcon sx={{ fontSize: phone ? 40 : 36 }} />
        )}
      </Fab>

      <IconButton
        aria-label="Next"
        onClick={() => player.next()}
        className={cn('!text-body', phone ? 'size-14' : 'size-12')}
      >
        <SkipNextIcon sx={{ fontSize: phone ? 36 : 32 }} />
      </IconButton>

      <IconButton
        aria-label={`Repeat: ${player.repeat}`}
        aria-pressed={player.repeat !== 'off'}
        onClick={player.cycleRepeat}
        className={cn(
          '![transition:background-color_160ms_ease,color_160ms_ease]',
          phone ? 'size-12' : 'size-11',
          player.repeat === 'off'
            ? '!text-muted hover:!bg-[color-mix(in_srgb,var(--app-text)_8%,transparent)]'
            : '!bg-accent-fg/14 !text-accent-fg hover:!bg-accent-fg/22',
        )}
      >
        {player.repeat === 'one' ? (
          <RepeatOneIcon fontSize="small" />
        ) : (
          <RepeatIcon fontSize="small" />
        )}
      </IconButton>
    </div>
  );
}
