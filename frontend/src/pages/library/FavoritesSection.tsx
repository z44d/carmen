/**
 * Favorites page — the Library's Favorites tab: every favorited song, most
 * recently favorited first, with the split that matters for an offline
 * player: which favorites already live on this device and which still need
 * the network. The filter chips do the splitting, the summary line always
 * shows both counts, and an online row carries the download button so a
 * favorite can be made offline in place.
 *
 * Heart toggles here mean "unfavorite" (every row already is one), so the
 * row drops out of the list the moment it is toggled — no refetch needed.
 * The offline flag is read live from the flags store on top of the loaded
 * snapshot, so a download finishing mid-session moves the row across the
 * filter without a reload.
 */
import { useEffect, useState, type KeyboardEvent } from 'react';

import { Button, Chip, IconButton, Shimmer, Tooltip } from '../../components/ui';
import { listFavorites } from '../../db/repos/favorites';
import { useFlags } from '../../db/flags';
import { usePlayer } from '../../player/PlayerContext';
import type { PlaylistSong } from '../../types/models';
import { cn } from '../../utils/cn';
import { shuffleList } from '../../utils/library';
import { EmptyHint, PageSummary } from './common';
import {
  ChevronRightIcon,
  DownloadIcon,
  HeartFilledIcon,
  PlayArrowIcon,
  ShuffleIcon,
  SortIcon,
} from './glyphs';
import SongRow from './SongRow';

/** The three availability filters, in display order. */
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'offline', label: 'On device' },
  { id: 'online', label: 'Online' },
] as const;
type FilterId = (typeof FILTERS)[number]['id'];

/** Title / artist chips, each toggling its direction on a second tap. */
const SORT_OPTIONS = [
  { key: 'title', label: 'Title' },
  { key: 'artist', label: 'Artist' },
] as const;
type FavSortKey = (typeof SORT_OPTIONS)[number]['key'];

/** `localeCompare` with the DB's NOCASE flavour + title tiebreak. */
function compareBy(key: FavSortKey, dir: 'asc' | 'desc') {
  const sign = dir === 'desc' ? -1 : 1;
  return (a: PlaylistSong, b: PlaylistSong) => {
    const primary = (a[key] ?? '').localeCompare(b[key] ?? '', undefined, { sensitivity: 'base' });
    if (primary !== 0) return sign * primary;
    return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  };
}

export default function FavoritesSection() {
  const player = usePlayer();
  const [songs, setSongs] = useState<PlaylistSong[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterId>('all');
  const [sort, setSort] = useState<FavSortKey | null>(null);
  const [dir, setDir] = useState<'asc' | 'desc'>('asc');
  // The load is "recently favorited first" (repo order); the chips re-sort
  // that snapshot in memory instead of re-querying.
  const [reloadKey, setReloadKey] = useState(0);
  // Live downloaded set: a save finishing mid-session flips a row's side of
  // the filter without waiting for a reload.
  const { downloaded } = useFlags();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // The browser store may need to heal metadata saved by older builds —
    // rows paint immediately and stream in through onUpdate as each batch
    // resolves, so a slow heal never holds the list hostage.
    listFavorites((rows) => {
      if (!cancelled) setSongs(rows);
    })
      .then((rows) => {
        if (!cancelled) {
          setSongs(rows);
          setLoading(false);
        }
      })
      .catch((loadError) => {
        console.warn('[library] load favorites failed', loadError);
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // Unfavoriting from this list removes the song from it outright.
  const handleFavoriteChange = (videoId: string, next: boolean) => {
    if (!next) {
      setSongs((rows) => rows.filter((row) => row.videoId !== videoId));
      return;
    }
    setReloadKey((key) => key + 1);
  };

  const isOnDevice = (song: PlaylistSong) => song.isDownloaded || downloaded.has(song.videoId);

  const pickSort = (key: FavSortKey) => {
    if (key === sort) setDir((current) => (current === 'asc' ? 'desc' : 'asc'));
    else {
      setSort(key);
      setDir('asc');
    }
  };

  // One ordered snapshot, then the availability filter on top of it.
  const ordered = sort ? [...songs].sort(compareBy(sort, dir)) : songs;
  const visible =
    filter === 'all'
      ? ordered
      : ordered.filter((song) => (filter === 'offline' ? isOnDevice(song) : !isOnDevice(song)));

  const offlineCount = songs.filter(isOnDevice).length;
  const onlineCount = songs.length - offlineCount;

  const playAll = () => player.playAll(visible, 0);

  const shuffleAll = () => {
    if (!visible.length) return;
    if (!player.shuffle) player.toggleShuffle();
    player.playAll(shuffleList(visible), 0);
  };

  const direction = dir === 'asc' ? '↑' : '↓';

  // MUI's Chip rendered `<button>` when clickable; the kit Chip is a `<span>`,
  // so Enter/Space are replayed as a click (with the usual repeat guard).
  const activateOnKey = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (!event.repeat) event.currentTarget.click();
  };

  return (
    <section>
      <PageSummary>
        {loading && !songs.length
          ? 'Loading…'
          : `${songs.length} favorite${songs.length === 1 ? '' : 's'} — ${offlineCount} on this device, ${onlineCount} online`}
      </PageSummary>

      <div className="mb-3 flex flex-wrap items-center gap-2 gap-y-2">
        {/* Sort: key chips + a direction toggle; the active chip shows ↑ / ↓.
            Until one is picked the list keeps the repo's recency order. */}
        <div className="flex items-center gap-[6px]">
          <SortIcon fontSize="small" sx={{ color: 'text.secondary' }} aria-hidden />
          {SORT_OPTIONS.map((option) => {
            const active = sort === option.key;
            return (
              <Chip
                key={option.key}
                size="small"
                label={active ? `${option.label} ${direction}` : option.label}
                className={cn(
                  'cursor-pointer focus-visible:outline-2 focus-visible:outline-accent',
                  active && '!bg-accent !text-accent-contrast',
                )}
                role="button"
                tabIndex={0}
                onKeyDown={activateOnKey}
                onClick={() => pickSort(option.key)}
                aria-label={`Sort by ${option.label}${active ? ` (${dir === 'asc' ? 'ascending' : 'descending'})` : ''}`}
              />
            );
          })}
          <Tooltip
            title={dir === 'asc' ? 'Ascending — switch to descending' : 'Descending — switch to ascending'}
          >
            <IconButton
              size="small"
              aria-label={dir === 'asc' ? 'Switch to descending' : 'Switch to ascending'}
              onClick={() => setDir((current) => (current === 'asc' ? 'desc' : 'asc'))}
            >
              <ChevronRightIcon
                sx={{
                  fontSize: 18,
                  transform: dir === 'asc' ? 'rotate(-90deg)' : 'rotate(90deg)',
                  transition: 'transform 200ms',
                }}
              />
            </IconButton>
          </Tooltip>
        </div>

        {/* Availability: All / On device / Online — the offline-first split. */}
        {FILTERS.map((option) => {
          const active = filter === option.id;
          return (
            <Chip
              key={option.id}
              size="small"
              label={
                option.id === 'offline' ? (
                  <>
                    <DownloadIcon />
                    {option.label}
                  </>
                ) : (
                  option.label
                )
              }
              className={cn(
                'cursor-pointer focus-visible:outline-2 focus-visible:outline-accent',
                active
                  ? '!bg-accent !text-accent-contrast'
                  : option.id === 'online'
                    ? '!border-accent/50 !text-accent-fg'
                    : '',
              )}
              role="button"
              tabIndex={0}
              onKeyDown={activateOnKey}
              onClick={() => setFilter(option.id)}
              aria-label={
                option.id === 'offline'
                  ? 'Only show favorites saved on this device'
                  : option.id === 'online'
                    ? 'Only show favorites that still need the network'
                    : 'Show every favorite'
              }
            />
          );
        })}

        <div className="flex gap-2 sm:ml-auto">
          <Button
            variant="contained"
            startIcon={<PlayArrowIcon />}
            disabled={!visible.length}
            onClick={playAll}
          >
            Play all
          </Button>
          {/* MIGRATION: the kit Button has no `outlined` variant — the text
              variant plus a border class is the closest match. */}
          <Button
            variant="text"
            className="border border-accent/50"
            startIcon={<ShuffleIcon />}
            disabled={!visible.length}
            onClick={shuffleAll}
          >
            Shuffle all
          </Button>
        </div>
      </div>

      {loading && !songs.length ? (
        <div>
          {[0, 1, 2, 3].map((index) => (
            <Shimmer key={index} variant="rounded" height={54} className="mb-2" />
          ))}
        </div>
      ) : songs.length === 0 ? (
        <EmptyHint
          icon={<HeartFilledIcon sx={{ fontSize: 40 }} />}
          title="No favorites yet"
          hint="Tap the heart on any song to keep it here — favorites play offline once they are downloaded."
        />
      ) : visible.length === 0 ? (
        filter === 'offline' ? (
          <EmptyHint
            title="Nothing saved on this device yet"
            hint="Switch to Online and tap the download arrow on a favorite — it will show up here, ready to play offline."
          />
        ) : (
          <EmptyHint
            title="Every favorite is already on this device"
            hint="Switch to All to see the full list — nothing here needs the network."
          />
        )
      ) : (
        <div>
          {visible.map((song) => (
            <SongRow
              key={song.videoId}
              track={song}
              contextTracks={visible}
              showAddToPlaylist
              // Online rows get the save button; the row's check mark takes
              // over the instant the download lands.
              showDownload={!isOnDevice(song)}
              onFavoriteChange={handleFavoriteChange}
            />
          ))}
        </div>
      )}
    </section>
  );
}
