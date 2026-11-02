import { IconButton, Tooltip } from './ui';

import { CheckCircleIcon, DownloadIcon } from './icons';
import { useFlag } from '../db/flags';
import { useDownloads } from '../hooks';
import { notify } from '../utils/downloadsStore';
import type { Track, TrackMeta } from '../types/models';

interface DownloadButtonProps {
  track: Track;
  meta: TrackMeta | null;
  /** See `PlayerContext.waitForCache`. */
  waitForCache?: () => Promise<void>;
  size?: 'small' | 'medium';
}

/** Ring geometry copied from MUI's `CircularProgress` (SIZE 44, thickness 3.6). */
const RING_RADIUS = (44 - 3.6) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * Download / progress control for a song.
 *
 * Shows a determinate ring while the raw audio + cover + lyrics land in the
 * sandbox, a check once it is part of the offline library, and the plain
 * download glyph otherwise.
 */
export default function DownloadButton({
  track,
  meta,
  waitForCache,
  size = 'medium',
}: DownloadButtonProps) {
  const { jobs } = useDownloads();
  const job = jobs[track.videoId];
  const running = job?.status === 'running';
  // The persisted flag (not the in-session job) decides the saved state, so a
  // song stays "saved" across re-plays and app restarts.
  const downloaded = useFlag('downloaded', track.videoId);
  const done = downloaded || job?.status === 'done';

  const label = running
    ? `${job?.step ?? 'Downloading'}${job?.progress ? ` — ${Math.round((job.progress || 0) * 100)}%` : ''}`
    : done
      ? 'Saved to your library'
      : job?.status === 'error'
        ? (job.error ?? 'Download failed — tap to retry')
        : 'Download for offline listening';

  const ringSize = size === 'small' ? 18 : 20;
  const ringValue = Math.round((job?.progress ?? 0) * 100);

  return (
    <Tooltip title={label} placement="top">
      <span>
        {/* MIGRATION: the kit has no `success` colour. `done` disables the
            button anyway, so the old disabled-grey cascade matched the kit's
            `disabled:` styling — `color` stays "default". */}
        <IconButton
          size={size}
          aria-label={label}
          disabled={running || done}
          onClick={() => {
            // Lazy-load the pipeline on the first tap — the module (audio
            // fetching, artwork, filesystem writes) stays out of the initial
            // bundle and is shared with the in-player menu.
            void import('../utils/downloads')
              .then((m) => m.startDownload(track, meta, { waitForCache }))
              .catch(() => notify('error', 'Could not start the download — try again'));
          }}
        >
          {running ? (
            /* MIGRATION: the kit `Spinner` only spins — the determinate ring is
                hand-drawn with MUI's exact geometry, accent colour and
                dashoffset transition (it used to be `CircularProgress
                variant="determinate"`). */
            <svg
              role="progressbar"
              aria-valuenow={ringValue}
              width={ringSize}
              height={ringSize}
              viewBox="22 22 44 44"
              className="block text-accent-fg"
              style={{ transform: 'rotate(-90deg)' }}
            >
              <circle
                cx={44}
                cy={44}
                r={RING_RADIUS}
                fill="none"
                strokeWidth={3.6}
                stroke="currentColor"
                strokeDasharray={RING_CIRCUMFERENCE.toFixed(3)}
                strokeDashoffset={(((100 - ringValue) / 100) * RING_CIRCUMFERENCE).toFixed(3)}
                style={{ transition: 'stroke-dashoffset 300ms cubic-bezier(0.4, 0, 0.2, 1)' }}
              />
            </svg>
          ) : done ? (
            <CheckCircleIcon fontSize={size} />
          ) : (
            <DownloadIcon fontSize={size} />
          )}
        </IconButton>
      </span>
    </Tooltip>
  );
}
