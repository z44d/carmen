import { useState } from 'react';

import {
  Collapse,
  Divider,
  IconButton,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
} from './ui';
import { Menu, MenuItem } from './ui/Overlay';
import { useFlag } from '../db/flags';
import { usePlayer } from '../player/PlayerContext';
import { useTheme } from '../theme/ThemeContext';
import type { Track, TrackMeta } from '../types/models';
import { cn } from '../utils/cn';
import { formatTime } from '../utils/format';
import { shareTrack } from '../utils/share';
import Artwork from './Artwork';
import DownloadButton from './DownloadButton';
import MarqueeText from './MarqueeText';
import {
  DownloadIcon,
  ExplicitIcon,
  HeartFilledIcon,
  InfoIcon,
  MoreVertIcon,
  MusicNoteIcon,
  PlayArrowIcon,
  PlusIcon,
  QueueMusicIcon,
  ShareIcon,
} from './icons';

/** Props for one row of the track list. */
export interface TrackRowProps {
  track: Track;
  /** Ordered list this track belongs to — the context it plays inside. */
  contextTracks?: Track[] | null;
  /** 1-based position shown instead of the cover art (`null` hides it). */
  index?: number | null;
  meta?: TrackMeta | null;
}

/**
 * MIGRATION: the bars used to carry their own `@keyframes eq-bar` inside
 * `sx`; one concatenated block reproduces the same cascade (same name, so
 * the last rule wins — exactly like the emotion injections did).
 */
const EQ_KEYFRAMES = [0.4, 1, 0.65]
  .map(
    (scale) => `@keyframes eq-bar {
  from { transform: scaleY(${scale * 0.35}); }
  to { transform: scaleY(${scale}); }
}`,
  )
  .join('\n');

function Equalizer() {
  // The bars are accent-coloured line art — read the readable accent here so
  // a white high-performance accent stays visible on a light row.
  const { accentFg } = useTheme();
  return (
    <div className="flex h-4 items-end gap-[3.2px]" aria-hidden>
      <style>{EQ_KEYFRAMES}</style>
      {[0.4, 1, 0.65].map((scale, position) => (
        <div
          key={position}
          className="h-4 w-[3px] origin-bottom rounded-[28px]"
          style={{
            backgroundColor: accentFg,
            animation: `eq-bar 900ms ${position * 140}ms ease-in-out infinite alternate`,
          }}
        />
      ))}
    </div>
  );
}

/**
 * One row of the track list. Tapping the row plays the track inside the
 * given context; the ⋯ menu offers queue actions, a collapsible details view
 * and the browser side MP3 download.
 */
export default function TrackRow({
  track,
  contextTracks = null,
  index = null,
  meta = null,
}: TrackRowProps) {
  const player = usePlayer();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Read the flags per row (not per list) so each badge flips live the moment
  // a download finishes or a heart is toggled anywhere in the app.
  const downloaded = useFlag('downloaded', track.videoId);
  const favorite = useFlag('favorite', track.videoId);

  const active = player.current?.videoId === track.videoId;
  // Accent used for text/lines painted on the row surface (active title,
  // index, EQ bars) — never the raw white accent, which would disappear on
  // a light background (see `accentFg` in ThemeContext).
  const { accentFg } = useTheme();
  const artwork = track.artwork;

  return (
    <>
      {/* MUI's `secondaryAction` rendered as a sibling of the row button —
          kept that way so ⋯ clicks never bubble into the play handler. */}
      <ListItem disablePadding className="relative flex items-center text-left">
        <ListItemButton
          onClick={() => player.playTrack(track, contextTracks)}
          className={cn(
            'font-ui hover:bg-hover',
            active ? 'bg-hover' : 'bg-transparent',
          )}
          style={{
            paddingTop: 6,
            paddingBottom: 6,
            paddingLeft: 12,
            paddingRight: 48,
            borderRadius: 12,
          }}
        >
          {artwork ? (
            <ListItemIcon sx={{ minWidth: 46 }}>
              <Artwork
                src={artwork}
                alt=""
                icon={MusicNoteIcon}
                iconSize={22}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 12,
                  border: '1px solid var(--app-divider)',
                }}
              />
            </ListItemIcon>
          ) : index !== null ? (
            <p
              className="m-0 w-[46px] text-center text-sm font-semibold leading-[1.43] text-muted"
              style={active ? { color: accentFg } : undefined}
            >
              {index + 1}
            </p>
          ) : (
            <ListItemIcon sx={{ minWidth: 46 }}>
              <Artwork
                src={null}
                icon={MusicNoteIcon}
                iconSize={22}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 12,
                  border: '1px solid var(--app-divider)',
                }}
              />
            </ListItemIcon>
          )}
          <ListItemText
            primary={
              // marquee instead of a bare ellipsis: a title wider than the
              // row glides through its box and the row width never grows
              <MarqueeText
                text={track.title}
                variant="body2"
                className="text-body"
                sx={{ fontWeight: active ? 700 : 500, color: active ? accentFg : undefined }}
              />
            }
            secondary={
              <span className="flex items-center gap-1 truncate text-xs leading-[1.4] text-body">
                {track.isExplicit && <ExplicitIcon sx={{ fontSize: 13 }} />}
                {/* Passive badges on the meta line — the trailing slot keeps the ⋯ menu / duration only.
                    `titleAccess` marks them meaningful for screen readers (SvgIcon is aria-hidden otherwise). */}
                {downloaded && (
                  <DownloadIcon
                    titleAccess="Downloaded"
                    sx={{ fontSize: 14, color: 'text.secondary', flexShrink: 0 }}
                  />
                )}
                {favorite && (
                  <HeartFilledIcon
                    titleAccess="Favorite"
                    sx={{ fontSize: 14, color: 'text.secondary', flexShrink: 0 }}
                  />
                )}
                {/* the artist shrinks first (`min-w-0 flex-1`) and glides
                    when longer than what is left of the row */}
                <MarqueeText
                  text={track.artist}
                  variant="caption"
                  className="min-w-0 flex-1"
                />
              </span>
            }
          />
        </ListItemButton>
        <div className="absolute right-4 top-1/2 flex -translate-y-1/2 items-center pr-1">
          {active && player.isPlaying ? <Equalizer /> : (
            <span className="mr-2 min-w-[34px] text-right text-xs leading-[1.4] text-muted">
              {track.duration ? formatTime(track.duration) : ''}
            </span>
          )}
          <IconButton
            size="small"
            aria-label={`Actions for ${track.title}`}
            onClick={(event) => setAnchor(event.currentTarget)}
          >
            <MoreVertIcon fontSize="small" />
          </IconButton>
        </div>
      </ListItem>

      {/* MIGRATION: `unmountOnExit` dropped — the kit's framer Collapse
          already unmounts once its exit animation finishes. */}
      <Collapse in={detailsOpen} timeout="auto">
        <div className="pb-3 pl-[60px] pr-2">
          <Divider className="mb-2" />
          <span className="text-xs leading-[1.4] text-muted">
            {[
              track.albumName,
              track.duration ? formatTime(track.duration) : null,
              track.isExplicit ? 'Explicit' : null,
            ]
              .filter(Boolean)
              .join('  •  ')}
          </span>
        </div>
      </Collapse>

      {/* MIGRATION: `anchorOrigin`/`transformOrigin` dropped — the kit Menu
          anchors under the element and flips when it would overflow. */}
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
      >
        <MenuItem
          className="font-ui"
          onClick={() => {
            player.playTrack(track, contextTracks);
            setAnchor(null);
          }}
        >
          <ListItemIcon><PlayArrowIcon fontSize="small" /></ListItemIcon>
          Play
        </MenuItem>
        <MenuItem
          className="font-ui"
          onClick={() => {
            player.playNext(track);
            setAnchor(null);
          }}
        >
          <ListItemIcon><PlusIcon fontSize="small" /></ListItemIcon>
          Play next
        </MenuItem>
        <MenuItem
          className="font-ui"
          onClick={() => {
            player.addToQueue(track);
            setAnchor(null);
          }}
        >
          <ListItemIcon><QueueMusicIcon fontSize="small" /></ListItemIcon>
          Add to queue
        </MenuItem>
        <MenuItem
          className="font-ui"
          onClick={() => {
            setAnchor(null);
            void shareTrack(track);
          }}
        >
          <ListItemIcon><ShareIcon fontSize="small" /></ListItemIcon>
          Share
        </MenuItem>
        <MenuItem
          className="font-ui"
          onClick={() => {
            setDetailsOpen((value) => !value);
            setAnchor(null);
          }}
        >
          <ListItemIcon><InfoIcon fontSize="small" /></ListItemIcon>
          {detailsOpen ? 'Hide details' : 'Show details'}
        </MenuItem>
        <MenuItem className="font-ui">
          <DownloadButton track={track} meta={meta} size="small" />
          <p className="m-0 text-sm leading-[1.43]">Download MP3</p>
        </MenuItem>
      </Menu>
    </>
  );
}
