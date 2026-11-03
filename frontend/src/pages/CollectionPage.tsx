import { useEffect, useState } from 'react';
import { Button, Collapse, Container, IconButton, Shimmer } from '../components/ui';
import { useNavigate, useParams } from 'react-router-dom';

import { apiGet } from '../api';
import { usePlayer } from '../player/PlayerContext';
import { normalizeList, pickArtwork } from '../utils/track';
import type { Thumbnail } from '../types/models';
import Artwork from '../components/Artwork';
import TrackList, { EmptyState } from '../components/TrackList';
import { ArrowBackIcon, ExpandMoreIcon, PlayArrowIcon, ShuffleIcon } from '../components/icons';

/** Any candidate shape `pickArtwork` understands; the payload is untyped JSON. */
type ArtworkInput =
  | string
  | null
  | undefined
  | { thumbnails?: Thumbnail[]; url?: string };

/** Album / playlist detail page with a collapsible description. */
export default function CollectionPage() {
  const { kind, id } = useParams();
  const navigate = useNavigate();
  const player = usePlayer();

  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [descriptionOpen, setDescriptionOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);

    const request =
      kind === 'album'
        ? apiGet(`/browsing/album/${id}`)
        : apiGet(`/playlists/${id}`, { limit: 100 });

    request
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        setLoading(false);
      })
      .catch((requestError: unknown) => {
        if (cancelled) return;
        setError(requestError instanceof Error ? requestError.message : String(requestError));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [kind, id]);

  if (loading) {
    return (
      <Container maxWidth="lg" className="!px-0 pt-6">
        <div className="flex flex-col gap-6 px-4 sm:flex-row md:px-10">
          <Shimmer variant="rounded" width={220} height={220} />
          <div className="flex-1">
            <Shimmer variant="text" width="60%" height={44} className="mb-[5px]" />
            <Shimmer variant="text" width="35%" className="mb-[5px]" />
            <Shimmer variant="text" width="25%" />
          </div>
        </div>
      </Container>
    );
  }

  if (error || !data) {
    return (
      <Container maxWidth="lg" className="!px-0 pt-8">
        <div className="px-4 md:px-10">
          <EmptyState title={`Could not load this ${kind}`} hint={error} />
        </div>
      </Container>
    );
  }

  const tracks = normalizeList(data.tracks || data.items || []);
  const artwork = pickArtwork(data.thumbnails as ArtworkInput, data.thumbnail as ArtworkInput);
  // The API is inconsistent: `artists` is either a list of `{ name }` or a
  // plain `author` string on the payload.
  const artistEntries = Array.isArray(data.artists) ? data.artists : null;
  const artists = artistEntries
    ? artistEntries
        .map((entry: unknown) =>
          entry && typeof entry === 'object'
            ? (entry as Record<string, unknown>).name
            : undefined,
        )
        .filter((name): name is string => typeof name === 'string' && Boolean(name))
        .join(', ')
    : typeof data.author === 'string'
      ? data.author
      : '';
  const description = typeof data.description === 'string' ? data.description : '';
  const title = data.title == null ? '' : String(data.title);

  const metaLine = [
    data.year,
    `${tracks.length} track${tracks.length === 1 ? '' : 's'}`,
    data.trackCount && data.trackCount !== tracks.length ? `${data.trackCount} songs` : null,
    data.duration,
  ]
    .filter(Boolean)
    .join('  •  ');

  return (
    <Container maxWidth="lg" className="!px-0 pt-4 md:pt-6">
      <div className="px-4 md:px-10">
      <IconButton aria-label="Back" onClick={() => navigate(-1)} className="mb-2 rounded-full border border-line">
        <ArrowBackIcon />
      </IconButton>

      <div className="mb-6 flex flex-col gap-6 sm:flex-row">
        <Artwork
          src={artwork}
          alt=""
          iconSize={64}
          className="w-[160px] sm:w-[220px] h-[160px] sm:h-[220px] mx-auto sm:mx-0"
          style={{
            borderRadius: 24,
            border: '1px solid var(--app-divider)',
            boxShadow: '0 16px 40px rgba(0,0,0,0.30)',
            flexShrink: 0,
          }}
        />
        <div className="min-w-0 flex-1 text-center sm:text-left">
          {/* MUI's `overline` variant: 12px, uppercase, the tall 2.66 line box. */}
          <span className="block text-xs font-bold uppercase leading-[2.66] tracking-[0.12em] text-muted">
            {kind === 'album' ? 'Album' : 'Playlist'}
          </span>
          <h5 className="m-0 text-[28px] font-extrabold leading-tight tracking-[-0.01em] md:text-4xl">{title}</h5>
          {artists && (
            <p className="m-0 mt-2 text-base leading-[1.5] text-muted">{artists}</p>
          )}
          <span className="mt-2 block text-[13px] leading-[1.4] text-muted">{metaLine}</span>

          <div className="mt-4 flex flex-row justify-center gap-2 sm:justify-start">
            <Button
              variant="contained"
              startIcon={<PlayArrowIcon />}
              disabled={!tracks.length}
              onClick={() => player.playAll(tracks, 0)}
              className="!h-10 !rounded-full !bg-body !px-6 !text-[15px] !text-bg hover:!brightness-90"
            >
              Play all
            </Button>
            <Button
              startIcon={<ShuffleIcon />}
              disabled={!tracks.length}
              className="!h-10 !rounded-full border border-line !bg-transparent !px-5 !text-[15px] !text-body hover:!bg-hover"
              onClick={() => {
                if (!player.shuffle) player.toggleShuffle();
                player.playAll(tracks, Math.floor(Math.random() * tracks.length));
              }}
            >
              Shuffle
            </Button>
          </div>

          {description && (
            <div className="mt-3 text-center sm:text-left">
              <Button
                endIcon={
                  <ExpandMoreIcon
                    sx={{ transform: descriptionOpen ? 'rotate(180deg)' : 'none', transition: 'transform 200ms' }}
                  />
                }
                onClick={() => setDescriptionOpen((value) => !value)}
              >
                {descriptionOpen ? 'Hide description' : 'About'}
              </Button>
              <Collapse in={descriptionOpen}>
                <p className="m-0 mt-2 max-h-[220px] overflow-y-auto whitespace-pre-line text-left text-sm leading-[1.43] text-muted">
                  {description}
                </p>
              </Collapse>
            </div>
          )}
        </div>
      </div>

      {tracks.length ? (
        <TrackList tracks={tracks} numbered={kind === 'album'} />
      ) : (
        <EmptyState title="Nothing to play here" hint="This collection has no playable tracks." />
      )}
      </div>
    </Container>
  );
}
