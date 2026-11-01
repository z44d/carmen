/**
 * Songs page — the Library's Songs tab: every downloaded song, with sorting
 * (title / release / artist, each direction), the favorites quick-filter,
 * Play All / Shuffle All and per-row hearts + "add to playlist". The tab bar
 * owns the title, so the page opens with the summary line only.
 *
 * The repo owns the SQL, so each control is one `listDownloads` query; a
 * heart toggle only refetches when the favorites filter is active (the row
 * would otherwise stay behind), otherwise it patches the row in place.
 */
import { useEffect, useState, type KeyboardEvent } from 'react';

import { Button, Chip, IconButton, Shimmer, Tooltip } from '../../components/ui';
import { listDownloads } from '../../db/repos/downloads';
import type { SortDir, SortKey } from '../../db/repos/tracks';
import { usePlayer } from '../../player/PlayerContext';
import type { DownloadedSong } from '../../types/models';
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

/** The three sort keys offered by the control, in display order. */
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'releaseDate', label: 'Release' },
  { key: 'artist', label: 'Artist' },
];

export default function SongsSection() {
  const player = usePlayer();
  const [songs, setSongs] = useState<DownloadedSong[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<SortKey>('title');
  const [dir, setDir] = useState<SortDir>('asc');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  // Bumped to force a refetch without touching the query keys.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listDownloads({ sort, dir, favoritesOnly })
      .then((rows) => {
        if (!cancelled) {
          setSongs(rows);
          setLoading(false);
        }
      })
      .catch((loadError) => {
        console.warn('[library] load downloads failed', loadError);
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sort, dir, favoritesOnly, reloadKey]);

  const pickSort = (key: SortKey) => {
    if (key === sort) setDir((current) => (current === 'asc' ? 'desc' : 'asc'));
    else {
      setSort(key);
      setDir('asc');
    }
  };

  const handleFavoriteChange = (videoId: string, next: boolean) => {
    if (favoritesOnly) {
      setReloadKey((key) => key + 1);
      return;
    }
    setSongs((rows) =>
      rows.map((row) => (row.videoId === videoId ? { ...row, isFavorite: next } : row)),
    );
  };

  const playAll = () => player.playAll(songs, 0);

  const shuffleAll = () => {
    if (!songs.length) return;
    if (!player.shuffle) player.toggleShuffle();
    player.playAll(shuffleList(songs), 0);
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
          : `${songs.length} downloaded song${songs.length === 1 ? '' : 's'} on this device`}
      </PageSummary>

      <div className="mb-3 flex flex-wrap items-center gap-2 gap-y-2">
        {/* Sort: key chips + a direction toggle; the active chip shows ↑ / ↓.
            The group never splits: it stays one row and the action
            buttons drop to their own row on a phone instead. */}
        <div className="flex shrink-0 flex-nowrap items-center gap-[6px]">
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
          <Tooltip title={dir === 'asc' ? 'Ascending — switch to descending' : 'Descending — switch to ascending'}>
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

        <Chip
          size="small"
          label={
            <>
              <HeartFilledIcon />
              Favorites
            </>
          }
          className={cn(
            'cursor-pointer focus-visible:outline-2 focus-visible:outline-accent',
            favoritesOnly ? '!bg-accent !text-accent-contrast' : '!border-accent/50 !text-accent',
          )}
          role="button"
          tabIndex={0}
          onKeyDown={activateOnKey}
          onClick={() => setFavoritesOnly((value) => !value)}
          aria-label="Only show favorites"
        />

        <div className="flex w-full gap-2 sm:ml-auto sm:w-auto">
          <Button variant="contained" startIcon={<PlayArrowIcon />} disabled={!songs.length} onClick={playAll}>
            Play all
          </Button>
          {/* MIGRATION: the kit Button has no `outlined` variant — the text
              variant plus a border class is the closest match. */}
          <Button
            variant="text"
            className="border border-accent/50"
            startIcon={<ShuffleIcon />}
            disabled={!songs.length}
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
        favoritesOnly ? (
          <EmptyHint
            title="No favorites here yet"
            hint="Tap the heart on a downloaded song to keep it in this filter."
          />
        ) : (
          <EmptyHint
            icon={<DownloadIcon sx={{ fontSize: 40 }} />}
            title="No downloads yet"
            hint="Download songs from Home or Search — they will show up here, ready to play offline."
          />
        )
      ) : (
        <div>
          {songs.map((song) => (
            <SongRow
              key={song.videoId}
              track={song}
              contextTracks={songs}
              showDownloaded
              showAddToPlaylist
              onFavoriteChange={handleFavoriteChange}
            />
          ))}
        </div>
      )}
    </section>
  );
}
