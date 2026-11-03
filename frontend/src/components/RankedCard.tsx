import { RANK_COLORS } from '../theme';
import type { Track } from '../types/models';
import { formatTime } from '../utils/format';
import Artwork from './Artwork';
import MarqueeText from './MarqueeText';
import type { MediaCardPlaySong } from './MediaCard';

/**
 * Ranked landscape card for the "Top played" row: a wide artwork backdrop
 * under a bottom scrim, a big rank numeral (gold / silver / bronze for the
 * top three, white-grey after), and the title + artist + year/duration
 * metadata overlaid. Tapping plays the track inside its row context —
 * exactly like a MediaCard tap.
 */
export default function RankedCard({
  track,
  rank,
  songsContext = null,
  onPlaySong,
}: {
  track: Track;
  rank: number;
  songsContext?: unknown[] | null;
  onPlaySong?: MediaCardPlaySong | null;
}) {
  const year = track.year || track.releaseDate?.slice(0, 4) || '';
  const duration =
    track.durationSeconds != null
      ? formatTime(track.durationSeconds)
      : track.duration
        ? formatTime(track.duration)
        : '';
  const meta = [year, duration].filter(Boolean).join('  •  ');
  const numeralColor = RANK_COLORS[rank - 1] ?? '#E5E7EB';

  return (
    <button
      type="button"
      onClick={() => onPlaySong?.(track as unknown as Record<string, unknown>, songsContext)}
      aria-label={`Play ${track.title} by ${track.artist}, ranked ${rank}`}
      className="group relative m-0 block w-[300px] shrink-0 cursor-pointer snap-start overflow-hidden rounded-xl border border-line bg-surface p-0 text-left font-ui focus-visible:outline-2 focus-visible:outline-accent md:w-[560px]"
      style={{ aspectRatio: '16 / 9' }}
    >
      <Artwork
        src={track.artwork}
        alt=""
        iconSize={44}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        imgStyle={{ transform: 'scale(1.02)' }}
      />
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(180deg, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.18) 42%, rgba(0,0,0,0.82) 100%), linear-gradient(90deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 55%)',
        }}
      />
      <div className="absolute inset-x-0 bottom-0 flex items-end gap-3 p-4 md:gap-4 md:p-5">
        <span
          aria-hidden
          className="shrink-0 font-extrabold leading-none tabular-nums"
          style={{
            color: numeralColor,
            fontSize: 'clamp(44px, 6vw, 64px)',
            textShadow: '0 2px 16px rgba(0,0,0,0.45)',
          }}
        >
          {rank}
        </span>
        <div className="min-w-0 flex-1 pb-1">
          <MarqueeText
            text={track.title}
            variant="subtitle1"
            className="text-white"
            sx={{ fontWeight: 700, textShadow: '0 1px 12px rgba(0,0,0,0.5)' }}
          />
          <span className="block truncate text-[13px] leading-[1.4] text-white/75">
            {[track.artist, meta].filter(Boolean).join('  •  ')}
          </span>
        </div>
      </div>
    </button>
  );
}
