/**
 * One song row of the Library lists (downloaded songs, playlist tracks).
 *
 * Self-contained on purpose: the heart, the "add to playlist" picker and the
 * row menu live here, so both lists stay a one-liner per track. Tapping the
 * row body plays the track inside its list's context; every other control is
 * a sibling of the play button (never nested inside it).
 */
import { useState } from 'react';

import DownloadButton from '../../components/DownloadButton';
import { IconButton, Tooltip } from '../../components/ui';
import { Menu, MenuItem } from '../../components/ui/Overlay';
import { useFlag } from '../../db/flags';
import { toggleFavorite } from '../../db/repos/favorites';
import { usePlayer } from '../../player/PlayerContext';
import { useTheme } from '../../theme/ThemeContext';
import type { Track } from '../../types/models';
import { formatTime } from '../../utils/format';
import { cn } from '../../utils/cn';
import AddToPlaylistDialog from './AddToPlaylistDialog';
import {
  Artwork,
  CheckCircleIcon,
  ExplicitIcon,
  HeartFilledIcon,
  HeartIcon,
  MoreVertIcon,
  MusicNoteIcon,
  PlaylistAddIcon,
  PlayArrowIcon,
  QueueMusicIcon,
  TrashIcon,
} from './glyphs';

/** A track plus the optional flags the downloaded / playlist rows carry. */
export type LibrarySong = Track & {
  isFavorite?: boolean;
  isDownloaded?: boolean;
};

export interface SongRowProps {
  track: LibrarySong;
  /** Everything reachable from this row — becomes the playback queue. */
  contextTracks?: Track[] | null;
  /** Filled check mark: the audio is on disk. */
  showDownloaded?: boolean;
  /** Shows the "add to playlist" button. */
  showAddToPlaylist?: boolean;
  /**
   * Shows the download button — for lists holding songs that are not on the
   * device yet (the Favorites tab's online rows). It steps aside the moment
   * the song is saved: the persisted check mark takes over below.
   */
  showDownload?: boolean;
  /** Enables the row menu with "Remove from this playlist". */
  onRemove?: () => void;
  /** Fires after a heart toggle — the list may need to refilter itself. */
  onFavoriteChange?: (videoId: string, next: boolean) => void;
}

/** Bars shown while this row is the one actually playing. */
function Equalizer() {
  // Accent line art again — the readable accent, never the raw white one.
  const { accentFg } = useTheme();
  return (
    <div className="flex h-[14px] items-end gap-[3.2px] pr-2" aria-hidden>
      {/* MIGRATION: the three bars used to inline their own emotion
          `@keyframes row-eq` (each with its own `scale`), but same-name
          keyframes overwrite each other in the stylesheet — the last bar's
          definition (0.65 → scaleY 0.2275…0.65) won for all three. One
          shared keyframes block reproduces that rendered behaviour; the
          per-bar stagger survives via the animation delays. */}
      <style>{'@keyframes row-eq{from{transform:scaleY(0.2275)}to{transform:scaleY(0.65)}}'}</style>
      {[0.4, 1, 0.65].map((scale, position) => (
        <span
          key={position}
          className="block h-[14px] w-[3px] origin-bottom rounded-[28px]"
          style={{
            backgroundColor: accentFg,
            animation: `row-eq 900ms ${position * 140}ms ease-in-out infinite alternate`,
          }}
        />
      ))}
    </div>
  );
}

export default function SongRow({
  track,
  contextTracks = null,
  showDownloaded = false,
  showAddToPlaylist = false,
  showDownload = false,
  onRemove,
  onFavoriteChange,
}: SongRowProps) {
  const player = usePlayer();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [addingToPlaylist, setAddingToPlaylist] = useState(false);

  // Both indicators read the flags store instead of prop snapshots, so they
  // flip the instant a download finishes or a heart is toggled anywhere —
  // no parent refetch required (`toggleFavorite` patches the same store).
  const favorite = useFlag('favorite', track.videoId);
  const downloaded = useFlag('downloaded', track.videoId);

  const active = player.current?.videoId === track.videoId;
  const playing = active && player.isPlaying;
  // Readable accent for active text / EQ bars (white accent + light mode
  // would otherwise paint invisible highlights).
  const { accentFg } = useTheme();

  const handleFavorite = async () => {
    const next = await toggleFavorite(track);
    onFavoriteChange?.(track.videoId, next);
  };

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-[12px] pr-2 hover:bg-hover',
        // `action.selected` has no token — 16% of the text colour, as before.
        active && 'bg-[color-mix(in_srgb,var(--app-text)_16%,transparent)]',
      )}
    >
      <button
        type="button"
        onClick={() => player.playTrack(track, contextTracks)}
        className="m-0 flex min-w-0 flex-1 cursor-pointer items-center gap-[10px] rounded-[12px] border-0 bg-transparent px-2 py-[6px] text-left text-inherit"
      >
        <Artwork
          src={track.artwork}
          alt=""
          icon={MusicNoteIcon}
          iconSize={20}
          style={{ width: 42, height: 42, borderRadius: 21, flexShrink: 0 }}
        />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'm-0 truncate text-sm leading-[1.43]',
              active ? 'font-bold' : 'font-medium',
            )}
            style={active ? { color: accentFg } : undefined}
          >
            {track.title}
          </p>
          <div className="flex min-w-0 items-center gap-1">
            {track.isExplicit && (
              <ExplicitIcon sx={{ fontSize: 13, color: 'text.secondary', flexShrink: 0 }} />
            )}
            <span className="truncate text-xs leading-[1.4] text-muted">
              {track.albumName ? `${track.artist}  •  ${track.albumName}` : track.artist}
            </span>
          </div>
        </div>
      </button>

      <div className="flex shrink-0 items-center gap-[2px]">
        {playing ? (
          <Equalizer />
        ) : (
          <span className="hidden min-w-[34px] text-right text-xs leading-[1.4] text-muted sm:block">
            {track.duration ? formatTime(track.duration) : ''}
          </span>
        )}

        {showDownload && !downloaded && (
          <DownloadButton
            track={track}
            meta={null}
            size="small"
            // Like the player menu: while the song streams here, its audio is
            // already on the wire — saving waits for that cache instead of
            // racing it with a second fetch.
            waitForCache={active ? () => player.waitForCache(track.videoId) : undefined}
          />
        )}

        {(showDownloaded || downloaded) && (
          <Tooltip title="Downloaded" placement="top">
            <CheckCircleIcon color="success" sx={{ fontSize: 18 }} className="hidden sm:flex" />
          </Tooltip>
        )}

        <Tooltip title={favorite ? 'Remove from favorites' : 'Add to favorites'} placement="top">
          <IconButton
            size="small"
            aria-label={favorite ? 'Remove from favorites' : 'Add to favorites'}
            color={favorite ? 'primary' : 'default'}
            onClick={() => void handleFavorite()}
          >
            {favorite ? <HeartFilledIcon fontSize="small" /> : <HeartIcon fontSize="small" />}
          </IconButton>
        </Tooltip>

        {showAddToPlaylist && (
          <Tooltip title="Add to playlist" placement="top">
            <IconButton
              size="small"
              aria-label="Add to playlist"
              onClick={() => setAddingToPlaylist(true)}
            >
              <PlaylistAddIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}

        {onRemove && (
          <IconButton
            size="small"
            aria-label={`Actions for ${track.title}`}
            onClick={(event) => setMenuAnchor(event.currentTarget)}
          >
            <MoreVertIcon fontSize="small" />
          </IconButton>
        )}
      </div>

      {/* MIGRATION: `anchorOrigin` / `transformOrigin` dropped — the kit Menu
          positions itself from the anchor and flips when it would overflow. */}
      <Menu
        anchorEl={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={() => setMenuAnchor(null)}
      >
        <MenuItem
          onClick={() => {
            player.playTrack(track, contextTracks);
            setMenuAnchor(null);
          }}
        >
          <PlayArrowIcon fontSize="small" />
          Play
        </MenuItem>
        <MenuItem
          onClick={() => {
            player.playNext(track);
            setMenuAnchor(null);
          }}
        >
          <QueueMusicIcon fontSize="small" />
          Play next
        </MenuItem>
        <MenuItem
          onClick={() => {
            setMenuAnchor(null);
            onRemove?.();
          }}
        >
          <TrashIcon fontSize="small" />
          Remove from this playlist
        </MenuItem>
      </Menu>

      <AddToPlaylistDialog
        open={addingToPlaylist}
        track={track}
        onClose={() => setAddingToPlaylist(false)}
      />
    </div>
  );
}
