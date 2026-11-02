import { IconButton, Spinner } from '../components/ui';

import { usePlayhead, usePlayer } from '../player/PlayerContext';
import { useEffectsEnabled } from '../settings/store';
import { cn } from '../utils/cn';
import Artwork from './Artwork';
import MarqueeText from './MarqueeText';
import { ExpandLessIcon, PauseIcon, PlayArrowIcon, SkipNextIcon } from './icons';

/** Props for the docked mini player. */
export interface MiniPlayerProps {
  /** CSS length the pill sits above the viewport bottom. */
  bottomOffset: string;
}

/**
 * Buffered/played rail along the bottom edge of the pill. It owns the
 * playhead subscription, so the 4 Hz ticks repaint these two divs only —
 * artwork, title and the buttons in `MiniPlayer` never re-render per tick.
 */
function MiniProgress() {
  const { currentTime, duration, buffered: bufferedSecs } = usePlayhead();
  // `duration` is metadata-preferred (see PlayerContext); clamp both rails so
  // an untrustworthy container that plays past the true length can't overflow
  // them.
  const progress = duration
    ? Math.min((currentTime / duration) * 100, 100)
    : 0;
  const buffered = duration ? Math.min((bufferedSecs / duration) * 100, 100) : 0;

  return (
    <div className="absolute inset-x-0 bottom-0 h-[3px] bg-[color-mix(in_srgb,var(--app-text)_8%,transparent)]">
      <div
        className="absolute left-0 top-0 h-full bg-[color-mix(in_srgb,var(--app-text)_20%,transparent)]"
        style={{ width: `${buffered}%` }}
      />
      <div
        className="absolute left-0 top-0 h-full bg-body"
        style={{
          width: `${progress}%`,
          transition: 'width 250ms linear',
        }}
      />
    </div>
  );
}

/**
 * iPhone-style floating mini player pill, docked above the bottom edge.
 * Tapping it opens the full player sheet.
 *
 * It sits just under `modal` in z-index and centres on wide screens. The
 * pill is glass in the current theme with a thin progress rail along its
 * bottom edge, square artwork, and a body-colour filled play circle —
 * instead of the old hard coded dark strip.
 */
export default function MiniPlayer({ bottomOffset }: MiniPlayerProps) {
  const player = usePlayer();
  const track = player.current;
  // The glass card (blur + translucent fill) is the first thing low
  // battery mode gives up.
  const effectsEnabled = useEffectsEnabled();

  if (!track) return null;

  return (
    <div
      onClick={() => player.setSheetOpen(true)}
      className={cn(
        // `group` carries the expand button's hover reveal (the old
        // `'&:hover .mini-expand'` selector).
        'group fixed z-[1299] cursor-pointer overflow-hidden rounded-[56px] border border-line text-body',
        // mobile keeps the edge insets; on desktop the bar is a centred
        // pill hugging its content — centred within the content area,
        // i.e. shifted right by half the 232px sidebar
        'left-2 right-2 sm:left-3 sm:right-3',
        'md:left-[calc(50vw+116px)] md:right-auto md:w-fit md:max-w-[min(560px,calc(100vw-264px))] md:-translate-x-1/2',
        // solid surface without the glass effect: the fill has to carry the
        // surface on its own once nothing blurs behind it
        effectsEnabled ? 'bg-surface/86' : 'bg-surface',
        'shadow-glass [transition:left_250ms_ease,opacity_200ms_ease,transform_160ms_ease,box-shadow_160ms_ease]',
        'hover:[transform:translateY(-2px)] hover:shadow-[0_16px_40px_rgba(0,0,0,0.2),0_3px_10px_rgba(0,0,0,0.1)]',
      )}
      style={{
        bottom: bottomOffset,
        backdropFilter: effectsEnabled ? 'blur(20px) saturate(1.6)' : 'none',
        WebkitBackdropFilter: effectsEnabled ? 'blur(20px) saturate(1.6)' : 'none',
      }}
    >
      {/* buffered (behind) + played (front) progress along the bottom
          edge — leaf component, so per-tick playhead updates never touch
          the rest of this bar */}
      <MiniProgress />
      <div className="flex items-center gap-3 px-[10px] py-1">
        <div className="relative h-11 w-11 shrink-0">
          <Artwork
            src={track.artwork}
            alt=""
            iconSize={20}
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              border: '1px solid var(--app-divider)',
              backgroundColor: 'var(--app-hover)',
            }}
          />
          {player.buffering && (
            <Spinner size={20} className="absolute inset-0 m-auto" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <MarqueeText
            text={track.title}
            variant="body2"
            sx={{ fontWeight: 600, lineHeight: 1.2 }}
          />
          <span className="block truncate text-xs leading-[1.4] text-muted">
            {track.artist}
          </span>
        </div>

        <IconButton
          aria-label={player.isPlaying ? 'Pause' : 'Play'}
          onClick={(event) => {
            event.stopPropagation();
            player.togglePlay();
          }}
          className="size-[42px] !bg-body !text-bg hover:!brightness-90 hover:[transform:scale(1.08)] ![transition:transform_150ms_ease,filter_150ms_ease]"
        >
          {player.isPlaying ? <PauseIcon /> : <PlayArrowIcon />}
        </IconButton>
        <IconButton
          size="small"
          aria-label="Next track"
          onClick={(event) => {
            event.stopPropagation();
            player.next();
          }}
          className="size-10 !text-muted hover:!text-body"
        >
          <SkipNextIcon />
        </IconButton>
        <IconButton
          size="small"
          className="mini-expand size-10 !text-muted hover:!text-body opacity-100 md:opacity-55 group-hover:!opacity-100 group-focus-within:!opacity-100"
          aria-label="Open player"
          onClick={(event) => {
            event.stopPropagation();
            player.setSheetOpen(true);
          }}
        >
          <ExpandLessIcon />
        </IconButton>
      </div>
    </div>
  );
}
