import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconButton, Spinner, Tooltip } from '../components/ui';
import type { ReactNode } from 'react';
import { usePlayer } from '../player/PlayerContext';
import { RECENT_LIMIT, shuffleList, useLibrary } from '../utils/library';
import { normalizeTrack } from '../utils/track';
import { formatTime } from '../utils/format';
import type { Track } from '../types/models';
import Artwork from '../components/Artwork';
import { LumiFooter, RowStrip, SectionHeader } from '../components/Lumi';
import MediaCard from '../components/MediaCard';
import type { MediaCardPlaySong } from '../components/MediaCard';
import NPFavorite from '../components/NPFavorite';
import RankedCard from '../components/RankedCard';
import { EmptyState } from '../components/TrackList';
import { HistoryIcon, PlayArrowIcon, RefreshIcon, ShuffleIcon } from '../components/icons';

/** How far the list has to be pulled down on a phone to refresh. */
const PULL_DISTANCE = 90;

/** Hero auto-rotation interval. */
const HERO_INTERVAL_MS = 6000;

/** Max hero slides (Lumi's 7-up strip). */
const HERO_LIMIT = 7;

/**
 * "Is the page at the very top?" — the page scrolls inside
 * `<main id="app-main">` (Layout), not the window, so the gesture reads
 * that scroller; the window fallback keeps the guard honest if the
 * layout ever hands scrolling back to the document.
 */
function atScrollerTop(): boolean {
  const scroller = document.getElementById('app-main');
  return (scroller ? scroller.scrollTop : window.scrollY) <= 0;
}

/** One hero slide's metadata line — real fields only: year, type, duration. */
function heroMeta(track: Track): ReactNode {
  const year = track.year || track.releaseDate?.slice(0, 4) || '';
  const duration =
    track.durationSeconds != null
      ? formatTime(track.durationSeconds)
      : track.duration
        ? formatTime(track.duration)
        : '';
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-semibold leading-[1.4] text-white/80">
      {year ? <span>{year}</span> : null}
      {year && duration ? <span aria-hidden>•</span> : null}
      <span className="rounded-full border border-white/30 bg-white/10 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-[0.08em]">
        Song
      </span>
      {duration ? (
        <>
          <span aria-hidden>•</span>
          <span className="tabular-nums">{duration}</span>
        </>
      ) : null}
    </span>
  );
}

/**
 * Full-bleed hero carousel (Lumi): the artwork fills the viewport-height
 * section under a bottom+left scrim, content sits bottom-left, Play starts
 * playback, Details opens the song, the heart saves it, the 7-up thumbnail
 * strip jumps between slides and the dot pill paginates. Auto-rotation
 * pauses on hover/focus and honours reduced motion.
 */
function HeroCarousel({
  items,
  onPlay,
}: {
  items: Track[];
  onPlay: (track: Track) => void;
}) {
  const navigate = useNavigate();
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const heroKey = items.map((item) => item.videoId).join(',');

  // A new feed starts back at the first slide.
  useEffect(() => {
    setActive(0);
    setEpoch((value) => value + 1);
  }, [heroKey]);

  useEffect(() => {
    if (paused || items.length < 2) return undefined;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      setActive((value) => (value + 1) % items.length);
    }, HERO_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [paused, items.length, epoch]);

  const goTo = (index: number) => {
    setActive(index);
    setEpoch((value) => value + 1);
  };

  const track = items[Math.min(active, items.length - 1)];
  if (!track) return null;

  const blurb = track.albumName
    ? `${track.artist} · ${track.albumName}`
    : track.artist;

  return (
    <section
      aria-label="Featured songs"
      className="relative h-[78svh] min-h-[540px] overflow-hidden md:h-[92svh]"
      style={{ marginTop: 'calc(var(--lumi-header) * -1)' }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {/* Backdrops: every slide stays mounted and cross-fades. */}
      {items.map((item, index) => (
        <div
          key={item.videoId}
          aria-hidden={index !== active}
          className="absolute inset-0 transition-opacity duration-700 ease-out"
          style={{ opacity: index === active ? 1 : 0 }}
        >
          <Artwork
            src={item.artwork}
            alt=""
            iconSize={72}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
            imgStyle={{ transform: 'scale(1.08)' }}
          />
        </div>
      ))}
      {/* Lumi scrims: dark at the bottom and the left, clear at the top. */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0) 30%, rgba(0,0,0,0.08) 55%, rgba(0,0,0,0.88) 100%), linear-gradient(90deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 60%)',
        }}
      />

      <div
        className="relative z-10 flex h-full flex-col justify-end px-4 pb-5 md:px-10"
        style={{ paddingTop: 'var(--lumi-header)' }}
      >
        <div className="max-w-[640px]">{heroMeta(track)}</div>
        <h1 className="m-0 mt-3 max-w-[640px] text-[34px] font-extrabold leading-[1.05] tracking-[-0.02em] text-white [text-wrap:balance] sm:text-5xl md:text-6xl">
          {track.title}
        </h1>
        <p className="m-0 mt-2 line-clamp-2 max-w-[640px] text-[15px] leading-[1.5] text-white/80">
          {blurb}
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => onPlay(track)}
            className="inline-flex h-10 items-center gap-2 rounded-full bg-white px-6 text-[15px] font-bold text-black shadow-glass transition hover:brightness-90 focus-visible:outline-2 focus-visible:outline-white active:scale-[0.97]"
          >
            <PlayArrowIcon fontSize="small" />
            Play
          </button>
          <button
            type="button"
            onClick={() => navigate(`/song/${track.videoId}`)}
            className="inline-flex h-10 items-center rounded-full border border-white/30 bg-white/10 px-5 text-[15px] font-semibold text-white backdrop-blur-md transition hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-white active:scale-[0.97]"
          >
            Details
          </button>
          <div className="glass-pill grid size-11 place-items-center rounded-full shadow-glass">
            <NPFavorite track={track} />
          </div>
        </div>

        {/* 7-up thumbnail strip */}
        <div className="mt-5 flex gap-2.5 overflow-x-auto pb-1">
          {items.map((item, index) => (
            <button
              key={item.videoId}
              type="button"
              onClick={() => goTo(index)}
              aria-label={`Show ${item.title} by ${item.artist}`}
              aria-current={index === active}
              className="relative shrink-0 overflow-hidden rounded-[10px] transition focus-visible:outline-2 focus-visible:outline-white"
              style={{
                width: 52,
                height: 52,
                outline: index === active ? '2px solid #ffffff' : '1px solid rgba(255,255,255,0.25)',
                outlineOffset: 1,
              }}
            >
              <Artwork
                src={item.artwork}
                alt=""
                iconSize={20}
                style={{ width: '100%', height: '100%' }}
              />
            </button>
          ))}
        </div>

        {/* Centred pagination dot pill */}
        <div className="mt-3 flex justify-center">
          <div className="flex items-center gap-1.5 rounded-full bg-black/40 px-3 py-2 backdrop-blur-md">
            {items.map((item, index) => (
              <button
                key={item.videoId}
                type="button"
                onClick={() => goTo(index)}
                aria-label={`Go to slide ${index + 1}: ${item.title}`}
                aria-current={index === active}
                className="h-2 rounded-full transition-all duration-300 focus-visible:outline-2 focus-visible:outline-white"
                style={{
                  width: index === active ? 20 : 8,
                  backgroundColor: index === active ? '#ffffff' : 'rgba(255,255,255,0.5)',
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Props shared by the home rows. */
interface FeedCardsProps {
  items: Track[];
  onPlaySong?: MediaCardPlaySong | null;
  songsContext?: unknown[] | null;
}

/**
 * Suggested strip: horizontal peek scrolling with adaptive paging — more
 * cards load as the reader scrolls sideways (600px before the end), so a
 * long suggestion list never renders all at once.
 */
function SuggestionStrip({ items, onPlaySong, songsContext }: FeedCardsProps) {
  const [count, setCount] = useState(12);
  const visible = items.slice(0, count);

  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget;
    if (node.scrollLeft + node.clientWidth > node.scrollWidth - 600) {
      setCount((value) => Math.min(value + 12, items.length));
    }
  };

  if (!items.length) return null;
  return (
    <RowStrip label="Suggested songs" onScroll={onScroll}>
      {visible.map((item, index) => (
        <MediaCard
          key={`${item.videoId || index}-${index}`}
          item={item}
          width={160}
          songsContext={songsContext}
          onPlaySong={onPlaySong}
        />
      ))}
    </RowStrip>
  );
}

/**
 * Home page.
 *
 * Top of the page is the personal feed, entirely cached on the client:
 * the 10 most recently played songs and up to 100 suggested songs harvested
 * from the related list of everything the user plays (shuffled on every
 * visit). The curated YouTube Music rows that used to sit underneath were
 * removed: the personal feed is all this page shows.
 *
 * The feed is shown as a **snapshot**: starting a song writes to the library
 * in the background, but the cards never reshuffle under the reader.  The
 * page picks the new state up only when the reader asks for it — pulling the
 * list down on a phone, or the refresh button.
 */
export default function HomePage() {
  const player = usePlayer();
  const library = useLibrary();
  const navigate = useNavigate();
  const [shuffleSeed, setShuffleSeed] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  // The visible feed.  Taken from the library on mount and on every refresh.
  const [feed, setFeed] = useState(() => ({
    recent: library.recent,
    suggestions: library.suggestions,
  }));

  const refresh = useCallback(() => {
    setFeed({ recent: [...library.recent], suggestions: [...library.suggestions] });
    setShuffleSeed((value) => value + 1);
    setRefreshing(true);
  }, [library]);

  // always call the latest refresh from the gesture listener
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    if (!refreshing) return undefined;
    const timer = window.setTimeout(() => setRefreshing(false), 500);
    return () => window.clearTimeout(timer);
  }, [refreshing]);

  // Pull to refresh: drag the page down while it is already at the top.
  useEffect(() => {
    let startY: number | null = null;

    const onTouchStart = (event: TouchEvent) => {
      startY =
        atScrollerTop() && event.touches.length === 1
          ? event.touches[0].clientY
          : null;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (startY === null) return;
      const distance = event.touches[0].clientY - startY;
      if (distance >= PULL_DISTANCE && atScrollerTop()) {
        startY = null;
        refreshRef.current();
      }
    };
    const onTouchEnd = () => {
      startY = null;
    };

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  const recentTracks = useMemo(
    () =>
      feed.recent
        .slice(0, RECENT_LIMIT)
        .map((entry) => normalizeTrack(entry))
        .filter((entry): entry is Track => entry !== null),
    [feed.recent],
  );

  // Suggestions are shuffled on mount and again on every refresh, never
  // because a song started playing.
  const suggestedTracks = useMemo(() => shuffleList(feed.suggestions), [feed, shuffleSeed]); // eslint-disable-line react-hooks/exhaustive-deps

  const suggestionContext = useMemo(
    () => [...recentTracks, ...suggestedTracks],
    [recentTracks, suggestedTracks],
  );

  // Hero slides: recents first, then suggestions, de-duplicated, max 7.
  const heroTracks = useMemo(() => {
    const seen = new Set<string>();
    const picked: Track[] = [];
    for (const track of [...recentTracks, ...suggestedTracks]) {
      if (seen.has(track.videoId)) continue;
      seen.add(track.videoId);
      picked.push(track);
      if (picked.length >= HERO_LIMIT) break;
    }
    return picked;
  }, [recentTracks, suggestedTracks]);

  const hasPersonalFeed = recentTracks.length > 0 || suggestedTracks.length > 0;

  const playFromSuggestions = (raw: Record<string, unknown>) => {
    const videoId = typeof raw.videoId === 'string' ? raw.videoId : null;
    const list = [raw, ...suggestionContext.filter((entry) => entry.videoId !== videoId)];
    player.playTrack(raw, list);
  };

  const playHero = (track: Track) => {
    player.playTrack(track, heroTracks);
  };

  return (
    <div className="w-full">
      {heroTracks.length > 0 && <HeroCarousel items={heroTracks} onPlay={playHero} />}

      <div className="flex flex-col gap-9 pt-7 md:gap-12 md:pt-9">
        {/* The feed only moves when the reader says so: pull it down on a
            phone, press this on a bigger screen. */}
        {hasPersonalFeed && (
          <div className="flex justify-end px-4 md:px-10">
            <Tooltip title="Refresh feed" placement="left">
              <span>
                <IconButton
                  aria-label="Refresh feed"
                  onClick={refresh}
                  disabled={refreshing}
                  className="rounded-full border border-line"
                >
                  {refreshing ? (
                    <Spinner size={20} />
                  ) : (
                    <RefreshIcon fontSize="small" />
                  )}
                </IconButton>
              </span>
            </Tooltip>
          </div>
        )}

        {/* ── Top played (ranked, from recent plays) ───────────────────── */}
        {recentTracks.length > 0 && (
          <section aria-label="Top played">
            <SectionHeader
              title="Top played"
              subtitle="Ranked from your recent plays"
              onSeeAll={() => player.playAll(recentTracks, 0)}
            />
            <RowStrip label="Top played">
              {recentTracks.slice(0, 9).map((track, index) => (
                <RankedCard
                  key={track.videoId}
                  track={track}
                  rank={index + 1}
                  songsContext={recentTracks}
                  onPlaySong={(raw, context) => player.playTrack(raw, context || recentTracks)}
                />
              ))}
            </RowStrip>
          </section>
        )}

        {/* ── Suggested songs (shuffled, max 100) ──────────────────────── */}
        {suggestedTracks.length > 0 && (
          <section aria-label="Suggested for you">
            <SectionHeader
              title="Suggested for you"
              subtitle={`${suggestedTracks.length} song${
                suggestedTracks.length === 1 ? '' : 's'
              } gathered from songs you play`}
              onSeeAll={() => player.playAll(suggestedTracks, 0)}
              action={
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => player.playAll(suggestedTracks, 0)}
                    className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-4 text-sm font-semibold text-body transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.97]"
                  >
                    <ShuffleIcon fontSize="small" />
                    Shuffle all
                  </button>
                  <Tooltip title="Reshuffle suggestions" placement="left">
                    <span>
                      <IconButton
                        size="small"
                        aria-label="Reshuffle suggestions"
                        onClick={() => setShuffleSeed((value) => value + 1)}
                        className="rounded-full border border-line"
                      >
                        <ShuffleIcon fontSize="small" color="disabled" />
                      </IconButton>
                    </span>
                  </Tooltip>
                </div>
              }
            />
            <SuggestionStrip
              items={suggestedTracks}
              songsContext={suggestionContext}
              onPlaySong={playFromSuggestions}
            />
          </section>
        )}

        {!hasPersonalFeed && (
          <div className="px-4">
            <EmptyState
              title="Nothing here yet"
              hint="Songs you play show up here: the last 10 plays plus up to 100 suggestions from their related songs."
            />
            <div className="flex justify-center pb-2">
              <button
                type="button"
                onClick={() => navigate('/search')}
                className="inline-flex h-10 items-center gap-2 rounded-full bg-white px-6 text-[15px] font-bold text-black transition hover:brightness-90 focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.97]"
              >
                <HistoryIcon fontSize="small" />
                Search music
              </button>
            </div>
          </div>
        )}
      </div>

      <LumiFooter />
    </div>
  );
}
