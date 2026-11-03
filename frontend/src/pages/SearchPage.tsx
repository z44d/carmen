import { useEffect, useMemo, useState } from 'react';
import { Chip, Container, Shimmer } from '../components/ui';
import { useSearchParams } from 'react-router-dom';

import { apiGet } from '../api';
import { usePlayer } from '../player/PlayerContext';
import { normalizeTrack } from '../utils/track';
import { loadSearchHistory, rememberSearch } from '../utils/searchHistory';
import type { Track } from '../types/models';
import MediaCard from '../components/MediaCard';
import TrackList, { EmptyState } from '../components/TrackList';
import { HistoryIcon } from '../components/icons';
import { cn } from '../utils/cn';

const FILTERS: { id: string; label: string }[] = [
  { id: '', label: 'All' },
  { id: 'songs', label: 'Songs' },
  { id: 'videos', label: 'Videos' },
  { id: 'albums', label: 'Albums' },
  { id: 'artists', label: 'Artists' },
  { id: 'playlists', label: 'Playlists' },
];

/**
 * Search opens on **Songs** — the filter a music player's search is about.
 * `All` is one chip tap away and survives in the URL as `?filter=all`;
 * every other chip deep-links as `?filter=<id>`.
 */
const DEFAULT_FILTER = 'songs';
const FILTER_IDS = new Set(FILTERS.map((option) => option.id));

/** Active filter from the URL; unknown or missing values land on Songs. */
function filterFromParams(params: URLSearchParams): string {
  const raw = params.get('filter');
  if (raw === 'all') return '';
  if (raw && FILTER_IDS.has(raw)) return raw;
  return DEFAULT_FILTER;
}

/** A raw search result that carries enough fields to play as a song. */
function isTrackLike(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const record = item as Record<string, unknown>;
  return Boolean(record.videoId) && Boolean(record.artists || record.album || record.duration || record.length);
}

/** React `key` of a result card: first identity field it carries. */
function cardKey(item: Record<string, unknown>, index: number): string {
  const identity = item.videoId || item.browseId || item.playlistId;
  if (typeof identity === 'string' && identity) return identity;
  return String(index);
}

/**
 * Search page — URL-driven only. The single search field lives in the
 * app header (`Layout.tsx`, with its suggestions dropdown); this page
 * carries no search field of its own. `?query=` and `?filter=` are the
 * whole state: typing in the header updates the URL (debounced,
 * replace) and the results run live, and arriving here with a
 * different query (the "Go to artist" / "Go to album" jumps in the
 * player's ⋯ menu) runs a new search. With no query, a tidy empty
 * state plus the user's real recent searches as tappable chips — no
 * fake or trending data.
 */
export default function SearchPage() {
  const player = usePlayer();
  const [searchParams, setSearchParams] = useSearchParams();

  const query = searchParams.get('query') || '';
  const filter = filterFromParams(searchParams);

  const [results, setResults] = useState<Record<string, unknown>[]>([]);
  const [history, setHistory] = useState<string[]>(loadSearchHistory);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refresh the recent-search chips whenever the page lands on an
  // empty query (history may have grown from the header meanwhile).
  useEffect(() => {
    if (!query) setHistory(loadSearchHistory());
  }, [query]);

  /** Navigate to a new query/filter, preserving the other param. */
  const goTo = (nextQuery: string, nextFilter: string) => {
    const next = new URLSearchParams();
    if (nextQuery) next.set('query', nextQuery);
    if (nextFilter !== DEFAULT_FILTER) next.set('filter', nextFilter || 'all');
    setSearchParams(next, { replace: true });
  };

  // Run the search whenever the URL query or filter changes.
  useEffect(() => {
    const term = query.trim();
    if (!term) {
      setResults([]);
      setError(null);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    apiGet('/search', { query: term, filter: filter || undefined, limit: 100 })
      .then((payload) => {
        if (cancelled) return;
        setResults(Array.isArray(payload) ? (payload as Record<string, unknown>[]) : []);
        setLoading(false);
        setError(null);
      })
      .catch((requestError: unknown) => {
        if (cancelled) return;
        setError(requestError instanceof Error ? requestError.message : String(requestError));
        setResults([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, filter]);

  const { songs, others } = useMemo(() => {
    const trackItems: Record<string, unknown>[] = [];
    const rest: Record<string, unknown>[] = [];
    results.forEach((item) => {
      if (isTrackLike(item)) trackItems.push(item);
      else rest.push(item);
    });
    return {
      songs: trackItems
        .map((entry) => normalizeTrack(entry))
        .filter((entry): entry is Track => entry !== null),
      others: rest,
    };
  }, [results]);

  const runRecent = (term: string) => {
    setHistory(rememberSearch(term));
    goTo(term, filter);
  };

  return (
    <Container maxWidth="lg" className="!px-0 pt-4 md:pt-6">
      <div className="flex flex-col gap-4 px-4 md:px-10">
        <h5 className="m-0 text-[26px] font-extrabold tracking-[-0.01em]">Search</h5>

        <div className="flex flex-row gap-2 overflow-x-auto pb-1">
          {FILTERS.map((option) => (
            <Chip
              key={option.id || 'all'}
              label={option.label}
              variant="outlined"
              onClick={() => goTo(query, option.id)}
              className={cn(
                'h-9 shrink-0 cursor-pointer !rounded-full !px-4 !text-sm !font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-accent',
                filter === option.id
                  ? '!border-transparent !bg-body !text-bg'
                  : '!border-line !bg-transparent !text-muted hover:!text-body',
              )}
            />
          ))}
        </div>

        {!query && !loading && (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <p className="m-0 text-base font-semibold text-body">Search from the bar above</p>
            <span className="block max-w-[340px] text-sm leading-[1.5] text-muted">
              Type a song, artist, album or playlist — suggestions appear as you type.
            </span>
            {history.length > 0 && (
              <div className="mt-2 flex flex-col items-center gap-2">
                <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-disabled">
                  <HistoryIcon fontSize="small" />
                  Recent searches
                </span>
                <div className="flex flex-wrap justify-center gap-2">
                  {history.map((term) => (
                    <Chip
                      key={term}
                      label={term}
                      variant="outlined"
                      onClick={() => runRecent(term)}
                      className="h-9 shrink-0 cursor-pointer !rounded-full !px-4 !text-sm !font-medium !border-line !bg-transparent !text-body hover:!text-body"
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {loading && (
          <div className="flex flex-col gap-3">
            {[0, 1, 2, 3, 4].map((row) => (
              <div key={row} className="flex flex-row items-center gap-4">
                <Shimmer variant="rounded" width={46} height={46} />
                <div className="flex-1">
                  <Shimmer variant="text" width="60%" className="mb-[5px]" />
                  <Shimmer variant="text" width="35%" />
                </div>
              </div>
            ))}
          </div>
        )}

        {error && <EmptyState title="Search failed" hint={error} />}

        {!loading && !error && query && !results.length && (
          <EmptyState title={`No results for “${query}”`} hint="Check the spelling or try another filter." />
        )}

        {!loading && songs.length > 0 && (
          <div>
            <p className="m-0 mb-2 text-[19px] font-bold leading-tight">Songs</p>
            <TrackList tracks={songs} />
          </div>
        )}

        {!loading && others.length > 0 && (
          <div>
            <p className="m-0 mb-2 text-[19px] font-bold leading-tight">
              {songs.length ? 'More results' : 'Results'}
            </p>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4 md:grid-cols-[repeat(auto-fill,minmax(168px,1fr))] md:gap-5">
              {others.map((item, index) => (
                <MediaCard
                  key={cardKey(item, index)}
                  item={item}
                  width="100%"
                  songsContext={songs}
                  onPlaySong={(raw) => player.playTrack(raw, songs)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </Container>
  );
}
