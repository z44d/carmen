import { useNavigate } from 'react-router-dom';

import { useFlags } from '../db/flags';
import { primaryArtwork } from '../utils/track';
import { formatTime } from '../utils/format';
import Artwork from './Artwork';
import { Chip } from './ui';
import { DownloadIcon, HeartFilledIcon, PlayArrowIcon } from './icons';
import MarqueeText from './MarqueeText';

/** Route / action to run when a browse item is tapped. */
export interface CardAction {
  kind: 'song' | 'playlist' | 'album' | 'artist';
  key: string;
}

/**
 * Channel id of an artist result.
 *
 * Most artist payloads carry it as `browseId`, but the all-tab's "Top
 * result" artist arrives with `browseId: null` and the channel only inside
 * `artists[0].id` — both are consulted so the card can open the artist page.
 */
function artistChannelId(record: Record<string, unknown>): string | null {
  const browseId = record.browseId;
  if (typeof browseId === 'string' && browseId.startsWith('UC')) return browseId;
  if (!Array.isArray(record.artists)) return null;
  for (const entry of record.artists) {
    if (entry && typeof entry === 'object') {
      const id = (entry as Record<string, unknown>).id;
      if (typeof id === 'string' && id.startsWith('UC')) return id;
    }
  }
  return null;
}

/** Name of an artist result — ytmusicapi leaves its `title` null. */
function artistNameOf(record: Record<string, unknown>): string {
  if (typeof record.artist === 'string' && record.artist) return record.artist;
  if (Array.isArray(record.artists)) {
    for (const entry of record.artists) {
      if (typeof entry === 'string' && entry) return entry;
      if (entry && typeof entry === 'object') {
        const name = (entry as Record<string, unknown>).name;
        if (typeof name === 'string' && name) return name;
      }
    }
  }
  return '';
}

/**
 * Classify an arbitrary browse item (home rows, search results, related).
 * Returns the route / action to run when the card is tapped.
 */
export function resolveCard(item: unknown): CardAction | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;

  if (
    record.videoId &&
    (record.artists || record.album || record.duration || record.length)
  ) {
    return { kind: 'song', key: `song-${String(record.videoId)}` };
  }
  if (record.playlistId) {
    return { kind: 'playlist', key: `playlist-${String(record.playlistId)}` };
  }
  if (typeof record.browseId === 'string' && record.browseId.startsWith('MPRE')) {
    return { kind: 'album', key: `album-${record.browseId}` };
  }
  const channel = artistChannelId(record);
  if (channel) return { kind: 'artist', key: `artist-${channel}` };
  if (record.videoId) return { kind: 'song', key: `song-${String(record.videoId)}` };
  if (record.browseId) return { kind: 'album', key: `album-${record.browseId}` };
  return null;
}

/** Callback invoked when a song card is tapped: the raw payload plus an optional play context. */
export type MediaCardPlaySong = (
  item: Record<string, unknown>,
  context: unknown[] | null
) => void;

/** Props for the card shelf/grid tile. Payloads stay `unknown`; narrowing happens here. */
export interface MediaCardProps {
  item: unknown;
  onPlaySong?: MediaCardPlaySong | null;
  /** Ordered list the played song belongs to (e.g. a shelf's songs). */
  songsContext?: unknown[] | null;
  width?: number | string;
}

export default function MediaCard({
  item,
  onPlaySong,
  songsContext = null,
  width = 156,
}: MediaCardProps) {
  const navigate = useNavigate();
  const card = resolveCard(item);
  // Badges on song tiles (home / search shelves): one store read per card,
  // live like everywhere else.
  const flags = useFlags();
  if (!card) return null;

  const record = (item ?? {}) as Record<string, unknown>;
  const videoId = typeof record.videoId === 'string' ? record.videoId : null;
  const isDownloaded = Boolean(videoId) && flags.downloaded.has(videoId as string);
  const isFavorite = Boolean(videoId) && flags.favorite.has(videoId as string);
  const isFluid = typeof width !== 'number';
  const boxWidth = isFluid ? width : `${width}px`;

  const artwork = primaryArtwork(item);
  // Artist results carry no `title` — ytmusicapi puts the name into `artist`
  // (or `artists[0].name` on the all-tab top result) — so they used to show
  // "Untitled" with the name underneath. Show the name *as* the title.
  const title =
    (typeof record.title === 'string' && record.title) ||
    (card.kind === 'artist' ? artistNameOf(record) : '') ||
    'Untitled';

  // Subtitle: explicit artist, joined artist list, or a fallback chain.
  // Artist cards skip the chain — their name is already the title; only the
  // subscriber count adds anything.
  let subtitle = '';
  if (card.kind === 'artist') {
    subtitle = typeof record.subscribers === 'string' ? record.subscribers : '';
  } else if (typeof record.artist === 'string' && record.artist) {
    subtitle = record.artist;
  } else if (Array.isArray(record.artists)) {
    subtitle = record.artists
      .map((artist) =>
        artist && typeof artist === 'object'
          ? (artist as Record<string, unknown>).name
          : undefined,
      )
      .filter((name): name is string => typeof name === 'string' && Boolean(name))
      .join(', ');
  } else if (typeof record.author === 'string' && record.author) {
    subtitle = record.author;
  } else if (typeof record.description === 'string' && record.description) {
    subtitle = record.description;
  } else if (typeof record.type === 'string' && record.type) {
    subtitle = record.type;
  }

  // Year comes only from real fields the payload carries — never invented.
  const yearText =
    typeof record.year === 'string' && record.year
      ? record.year.slice(0, 4)
      : typeof record.releaseDate === 'string' && record.releaseDate
        ? record.releaseDate.slice(0, 4)
        : '';
  const subtitleLine =
    card.kind === 'artist'
      ? subtitle
      : [subtitle, yearText].filter(Boolean).join('  •  ');

  // Duration glass pill (song cards only) — real duration fields only.
  const durationText =
    typeof record.duration === 'string' && record.duration
      ? formatTime(record.duration)
      : typeof record.length === 'string' && record.length
        ? formatTime(record.length)
        : '';

  const handleClick = () => {
    if (card.kind === 'song' && onPlaySong) {
      onPlaySong(record, songsContext);
    } else if (card.kind === 'album') {
      navigate(`/collection/album/${String(record.browseId)}`);
    } else if (card.kind === 'playlist') {
      navigate(`/collection/playlist/${String(record.playlistId)}`);
    } else if (card.kind === 'artist') {
      const channel = artistChannelId(record);
      if (channel) navigate(`/artist/${encodeURIComponent(channel)}`);
    }
  };

  // Lumi cards: square 1:1 artwork with a 12px radius and a hairline
  // border; circle artwork is for artist cards only.
  const isArtist = card.kind === 'artist';

  // Grid/flex children default to an automatic minimum of their min-content
  // width — a nowrap title would inflate the card over its neighbours and
  // defeat MarqueeText's overflow measurement (`min-w-0` keeps it honest).
  // The stretch has to be explicit: WebKit's UA stylesheet pins
  // `align-items: flex-start` on <button>, so on older macOS WKWebView
  // (Tauri) the text cell would otherwise size to the full nowrap title
  // instead of the card, and the marquee would never engage.
  return (
    <button
      type="button"
      onClick={handleClick}
      className="m-0 flex min-w-0 cursor-pointer snap-start flex-col items-stretch gap-2 border-none bg-transparent p-0 text-left font-ui hover:[&_.card-art]:[transform:scale(1.02)] hover:[&_.card-play]:translate-y-0 hover:[&_.card-play]:opacity-100"
      style={{ width: boxWidth, flex: isFluid ? 'auto' : `0 0 ${boxWidth}` }}
    >
      <div className="relative aspect-square w-full">
        <Artwork
          className="card-art"
          src={artwork}
          alt=""
          iconSize={44}
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: isArtist ? '50%' : 12,
            border: '1px solid var(--app-divider)',
            transition: 'transform 220ms ease',
          }}
        />
        {(isDownloaded || isFavorite) && (
          <div className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-[rgba(0,0,0,0.62)] px-[6px] py-0.5 text-white">
            {isDownloaded && <DownloadIcon sx={{ fontSize: 13 }} />}
            {isFavorite && <HeartFilledIcon sx={{ fontSize: 13 }} />}
          </div>
        )}
        {card.kind === 'song' && durationText && (
          <span className="absolute bottom-1.5 left-1.5 rounded-full bg-[rgba(0,0,0,0.62)] px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white backdrop-blur-sm">
            {durationText}
          </span>
        )}
        {card.kind === 'song' && (
          <div className="card-play absolute bottom-1.5 right-1.5 grid h-9 w-9 translate-y-1.5 place-items-center rounded-full bg-white text-black opacity-0 transition-all duration-200 ease-[ease]">
            <PlayArrowIcon />
          </div>
        )}
      </div>
      <div className="w-full min-w-0">
        <MarqueeText text={title} variant="body2" sx={{ fontWeight: 600, fontSize: 15 }} />
        <span className="block truncate text-[13px] leading-[1.4] text-muted">
          {subtitleLine ||
            (card.kind === 'song'
              ? 'Song'
              : card.kind === 'artist'
                ? '' // the name is the title — nothing left to add
                : card.kind)}
        </span>
      </div>
      {record.isExplicit === true && (
        <Chip label="E" size="small" variant="outlined" style={{ height: 18 }} />
      )}
    </button>
  );
}
