import Artwork from "../components/Artwork";
import MarqueeText from "../components/MarqueeText";
import QueueTab from "../components/QueueTab";
import RelatedTab from "../components/RelatedTab";
import { Chip, Container } from "../components/ui";
import { EmptyState } from "../components/TrackList";
import { usePlayer } from "../player/PlayerContext";

/**
 * Queue page: now playing, up next and the related songs that keep the
 * music going when the queue ends.
 */
export default function QueuePage() {
  const player = usePlayer();
  const track = player.current;

  if (!track) {
    return (
      <Container maxWidth="md" className="pt-6">
        <h5 className="m-0 mb-4 text-2xl font-bold">
          Queue
        </h5>
        <EmptyState
          title="Nothing is playing yet"
          hint="Start a song from the home page or search."
        />
      </Container>
    );
  }

  return (
    <Container maxWidth="md" className="pt-3 md:pt-6">
      <div className="flex flex-col gap-4">
        <div>
          <h5 className="m-0 text-[26px] font-extrabold tracking-[-0.01em]">Queue</h5>
          <p className="m-0 text-sm leading-[1.43] text-muted">
            Now playing
          </p>
        </div>

        <div
          onClick={() => player.setSheetOpen(true)}
          className="flex cursor-pointer items-center gap-4 rounded-2xl border border-line bg-surface p-3"
        >
          <Artwork
            src={track.artwork}
            alt=""
            iconSize={28}
            style={{ width: 64, height: 64, borderRadius: 12, border: '1px solid var(--app-divider)', flexShrink: 0 }}
          />
          <div className="min-w-0 flex-1">
            <MarqueeText text={track.title} variant="subtitle1" />
            <span className="block truncate text-xs leading-[1.4] text-muted">
              {track.artist}
            </span>
            <Chip
              size="small"
              label={player.isPlaying ? 'Playing' : 'Paused'}
              variant="outlined"
              className="mt-[6px] !h-5 !border-accent/50 !text-accent"
            />
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-line bg-surface">
          <QueueTab />
        </div>

        <div>
          <p className="m-0 mb-1 px-2 text-[19px] font-bold leading-tight">
            Related songs
          </p>
          <div className="overflow-hidden rounded-2xl border border-line bg-surface">
            <RelatedTab />
          </div>
        </div>
      </div>
    </Container>
  );
}
