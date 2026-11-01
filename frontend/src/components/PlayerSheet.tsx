import Artwork from "./Artwork";
import DownloadButton from "./DownloadButton";
import LyricsView from "./LyricsView";
import MarqueeText from "./MarqueeText";
import NPControls from "./NPControls";
import NPFavorite from "./NPFavorite";
import NPQueue from "./NPQueue";
import NPScrubber from "./NPScrubber";
import VolumeSlider from "./VolumeSlider";
import PlayerMenu from "./PlayerMenu";
import RelatedTab from "./RelatedTab";
import { useNavigate } from "react-router-dom";
import { useIsDesktop } from "../hooks";
import { usePlayer } from "../player/PlayerContext";
import { useEffectsEnabled, useSettings } from "../settings/store";
import { useTheme as useAppTheme } from "../theme/ThemeContext";
import { cn } from "../utils/cn";
import { alpha } from "../utils/color";
import { lyricsOf } from "../utils/lyrics";
import { pickArtwork } from "../utils/track";
import type { ArtworkPlacement, CoverSize } from '../types/models';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type TouchEvent,
} from 'react';
import {
  Alert,
  Button,
  Dialog,
  IconButton,
  Spinner,
  Tab,
  Tabs,
} from '../components/ui';

import {
  CloseIcon,
  ExpandMoreIcon,
  ExplicitIcon,
  FullScreenIcon,
  ExitFullScreenIcon,
  LyricsIcon,
  QueueMusicIcon,
  RelatedIcon,
  RefreshIcon,
} from './icons';

import { useMotionArtwork } from '../artwork/motion';
import { useVideoPowerGuard } from '../artwork/useVideoPowerGuard';
import { isTauri } from '../platform/env';
import { useAnimatedArtwork } from '../settings/store';

/** Tab order inside the player: 0 lyrics · 1 queue · 2 related. */
const LYRICS_TAB = 0;
const QUEUE_TAB = 1;
const RELATED_TAB = 2;

/** Pixels of downward swipe on the handle that dismiss the sheet. */
const DISMISS_DISTANCE = 72;


/**
 * Shared metrics of the three tabs (the old `TAB_SX`): 50px tall, no
 * minimum width so they can share the strip, semibold label — the kit Tab
 * already renders without `text-transform`.
 */
const TAB_CLASS = 'min-h-[50px] min-w-0 !font-semibold';

/**
 * Cover-tile width caps per Settings → Player cover size. Each entry keeps
 * the phone / tablet / desktop ladder of the default (viewport- and
 * height-capped on phones, column-capped on desktop) and steps it up for
 * Large / Very large.
 */
const COVER_MAXW: Record<CoverSize, string> = {
  default: 'max-w-[min(86vw,392px,max(200px,calc(100dvh-430px)))] sm:max-w-[min(60vw,340px)] md:max-w-[min(100%,440px)]',
  large: 'max-w-[min(88vw,440px,max(220px,calc(100dvh-410px)))] sm:max-w-[min(62vw,384px)] md:max-w-[min(100%,500px)]',
  veryLarge: 'max-w-[min(90vw,488px,max(240px,calc(100dvh-390px)))] sm:max-w-[min(64vw,428px)] md:max-w-[min(100%,560px)]',
};

/**
 * The full "Now Playing" experience, in two shapes switched at the `md`
 * breakpoint:
 *
 * * **Phone** — a full-screen sheet over the window. A grab *handle* sits on
 *   the top edge: tap it or swipe it down to dismiss (the sheet follows the
 *   finger while the swipe is in flight). Below it: artwork,
 *   title / artist / album, scrubber, transport, and the
 *   secondary row — lyrics · queue · related · favorite · download — all of
 *   it inside thumb reach. The three panels take the screen over from a
 *   compact now-playing card when one of those buttons is tapped.
 * * **Desktop / tablet** — a *centred* modal sized inside the window
 *   (`min(1120px, 100vw − 64px)` × `min(760px, 100vh − 64px)`), split into
 *   two columns: the cover on the left, and
 *   info → scrubber → transport → lyrics / queue / related on the right.
 *   The sheet itself never scrolls on either axis — only the lyrics /
 *   queue / related lists do, inside their own boxes — so a stray gesture
 *   near the scrubber thumb can never move the page under the finger.
 *
 * Mounting is unchanged: `Layout` renders this once and the player
 * context's `sheetOpen` / `setSheetOpen` drive the open/close mechanics.
 */
export default function PlayerSheet() {
  const player = usePlayer();
  // Line art on the sheet surface (focus ring, spinner, artist hover) needs
  // the readable accent — white on a light sheet would be invisible. It
  // reaches the CSS through the `accent-fg` token now; `resolved` picks the
  // theme-coloured scrim over the motion loops.
  const { resolved } = useAppTheme();
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  // The blurred artwork layer (the wash behind the sheet) is the expensive
  // part of this screen — low battery mode
  // drops it and keeps the plain surfaces.
  const effectsEnabled = useEffectsEnabled();

  const [tab, setTab] = useState<number>(LYRICS_TAB);
  /** Phone only: a panel (lyrics / queue / related) has taken the screen. */
  const [panelOpen, setPanelOpen] = useState(false);

  const track = player.current;
  const meta = player.meta;
  const videoId = track?.videoId;

  // ── Swipe-to-dismiss bookkeeping (phone handle) ─────────────────────────
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const dragStartY = useRef<number | null>(null);
  const dragDistance = useRef(0);
  /** True between a real swipe and the click the browser synthesises after it. */
  const draggedRef = useRef(false);
  /** Nearest scrollable ancestor of the current sheet-zone gesture, if any. */
  const scrollParentRef = useRef<HTMLElement | null>(null);
  /** When the last real swipe ended — the click the browser synthesises after it is swallowed. */
  const swipeEndedAt = useRef(0);

  // A new song drops straight back to the default panel (lyrics).
  useEffect(() => {
    setPanelOpen(false);
    setTab(LYRICS_TAB);
  }, [videoId]);

  // A fresh open always starts at zero. Usually the node is brand new, but
  // if the sheet is reopened while its slide-down exit is still running the
  // old node survives — and with it the last drag's offset.
  useEffect(() => {
    if (!player.sheetOpen) return;
    const node = sheetRef.current;
    if (!node) return;
    node.style.transition = 'none';
    node.style.transform = '';
    node.style.opacity = '';
  }, [player.sheetOpen]);

  // The system/browser Back closes the sheet instead of navigating the page
  // away underneath it. Opening pushes a history entry (same URL, so the
  // router never notices); Back pops it and we close. Dismissing any other
  // way consumes that entry so the next Back still navigates normally.
  const dismissedByBack = useRef(false);
  useEffect(() => {
    if (!player.sheetOpen) return undefined;
    window.history.pushState({ ...window.history.state, carmenSheet: true }, '');
    const onPopState = () => {
      dismissedByBack.current = true;
      setPanelOpen(false);
      setTab(LYRICS_TAB);
      player.setSheetOpen(false);
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      // A Back-triggered close already popped our entry (so `history.state`
      // no longer carries `carmenSheet`); a UI close has not — drop it here.
      if (!dismissedByBack.current && window.history.state?.carmenSheet) {
        window.history.back();
      }
      dismissedByBack.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.sheetOpen]);

  // ── Full screen (desktop card) ──────────────────────────────────────────
  // The now-playing card can be blown up to fill the whole display. On
  // desktop this expands the card *and* puts the window (Tauri) or the
  // document (browser) into real full screen; on a phone the sheet already
  // covers everything, so the control never appears there.
  const [fullScreen, setFullScreen] = useState(false);

  /**
   * Drop full screen — the sheet stays open, the window (Tauri) or the
   * document (browser) returns to normal. Shared by the sheet-close sweep
   * below and by Esc / backdrop in cinematic mode.
   */
  const exitFullScreen = useCallback(() => {
    setFullScreen(false);
    if (isTauri) {
      void import('@tauri-apps/api/window')
        .then((win) => win.getCurrentWindow().setFullscreen(false))
        .catch(() => {});
    } else if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
  }, []);

  // Browser Esc / system exit keeps the toggle honest.
  useEffect(() => {
    const onFullScreenChange = () => setFullScreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFullScreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullScreenChange);
  }, []);

  // Closing the sheet drops any full-screen mode with it.
  useEffect(() => {
    if (player.sheetOpen || !fullScreen) return;
    exitFullScreen();
  }, [player.sheetOpen, fullScreen, exitFullScreen]);

  const toggleFullScreen = async () => {
    const next = !fullScreen;
    setFullScreen(next);
    try {
      if (isTauri) {
        const win = await import('@tauri-apps/api/window');
        await win.getCurrentWindow().setFullscreen(next);
      } else if (next) {
        await document.documentElement.requestFullscreen?.();
      } else {
        await document.exitFullscreen?.();
      }
    } catch {
      /* full screen is best-effort — the card still expands via the CSS below */
    }
  };

  const lyrics = useMemo(() => lyricsOf(meta), [meta]);

  // The album's YouTube Music browse id — the key the server fallback uses to
  // resolve an iTunes collection id when the client's own search is blocked.
  const metaAlbumId =
    meta && typeof meta.album === 'object' && meta.album ? meta.album.id ?? null : null;

  // Animated cover identity for this track — the sheet resolves it once
  // (memoised in `artwork/motion`) and renders it as the video layers
  // below: the whole card on desktop, only the lyrics page on a phone.
  // Now Playing is the only screen that animates; every cover tile and
  // grid stays static (Apple Music does the same).
  const motionRef = track
    ? {
        album: track.albumName,
        albumId: track.album?.id || metaAlbumId,
        videoId: track.videoId,
        title: track.title,
        artist: track.artist,
      }
    : null;
  const animatedArtwork = useAnimatedArtwork();
  const { animatedArtworkPlacement, coverSize, cinematicMode, cinematicCover } = useSettings();
  // Effective surface for the motion loop: `default` follows the device —
  // the whole card on desktop, behind the lyrics on a phone — the explicit
  // values pin one surface everywhere, and `thumbnail` animates the cover
  // tile itself instead of any background.
  const motionPlacement: ArtworkPlacement =
    animatedArtworkPlacement === 'default'
      ? isDesktop
        ? 'player'
        : 'lyrics'
      : animatedArtworkPlacement;
  // Resolves only while the sheet is open: listening without looking at the
  // player costs no catalogue calls at all.
  const motionUrl = useMotionArtwork(motionRef, animatedArtwork && player.sheetOpen);
  const [motionReady, setMotionReady] = useState(false);
  useEffect(() => {
    setMotionReady(false);
  }, [motionUrl]);
  // The loops are decorative — when nobody can see them they must not cost
  // a single decoded frame. The guard pauses each element on minimize,
  // hide, focus loss or scroll-out and resumes it only when every signal
  // allows again (see artwork/useVideoPowerGuard).
  const cardVideoRef = useRef<HTMLVideoElement | null>(null);
  const panelVideoRef = useRef<HTMLVideoElement | null>(null);
  const coverVideoRef = useRef<HTMLVideoElement | null>(null);
  useVideoPowerGuard(cardVideoRef, Boolean(motionUrl));
  useVideoPowerGuard(panelVideoRef, Boolean(motionUrl));
  useVideoPowerGuard(coverVideoRef, Boolean(motionUrl));
  // Readability scrim shared by both motion layers — theme-coloured so the
  // light mode sheet stays light and the dark one stays dark.
  const motionScrim =
    resolved === 'dark'
      ? 'linear-gradient(180deg, rgba(10,13,11,0.48) 0%, rgba(10,13,11,0.72) 100%)'
      : 'linear-gradient(180deg, rgba(246,247,246,0.62) 0%, rgba(246,247,246,0.82) 100%)';

  /**
   * Cinematic mode (Settings → Cinematic mode): full screen with every
   * affordance stripped — no close button, no transport, no scrubber, no
   * tab strip — just the song's details and the lyrics riding the artwork
   * backdrop. Esc (the kit Dialog's `onClose`) lands in `handleClose` and
   * leaves the immersion; the player card comes back with its controls.
   */
  const cinematic = isDesktop && fullScreen && cinematicMode;

  const handleClose = () => {
    // In cinematic mode a dismissal (Esc, backdrop) exits full screen
    // instead of closing the sheet — the only way out is back through the
    // regular card, exactly like the mode promises.
    if (cinematic) {
      exitFullScreen();
      return;
    }
    setPanelOpen(false);
    setTab(LYRICS_TAB);
    player.setSheetOpen(false);
  };

  /** Phone: secondary-row buttons open their panel full screen. */
  const openPanel = (nextTab: number) => {
    setTab(nextTab);
    setPanelOpen(true);
  };

  // MIGRATION: the kit Tabs calls `onChange(value)` — no MUI event argument.
  const onTabChange = (value: unknown) => setTab(value as number);

  if (!track) return null;

  // Largest artwork first: the API returns every size sorted smallest to
  // biggest, so prefer the song's own i.ytimg cover (maxresdefault) and let
  // `pickArtwork` fall back to the meta thumbnails.
  const artwork = track.artwork || pickArtwork({ thumbnails: meta?.thumbnails });

  const searchArtist = () => {
    if (!track.artist) return;
    player.setSheetOpen(false);
    navigate(`/search?query=${encodeURIComponent(track.artist)}`);
  };

  /**
   * Retry plays through the context: it re-points the element at the
   * current song's best source (downloaded file, then stream) and keeps the
   * fallback chain's record of what the element plays in sync, so a retry
   * that itself fails still walks the full chain and reports the real
   * error.
   */
  const retry = () => player.retry();

  // ── Phone swipe gestures ───────────────────────────────────────────────
  const onStripTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    dragStartY.current = event.touches[0]?.clientY ?? null;
    draggedRef.current = false;
    dragDistance.current = 0;
    scrollParentRef.current = null;
    const node = sheetRef.current;
    if (node) node.style.transition = 'none';
  };

  /**
   * The whole top half of the phone sheet is a dismiss zone, not just the
   * handle: a gesture that begins there drags the sheet exactly like the
   * strip's does. Classified once at touchstart and left alone when it
   * belongs to something else — a scrubber drag, or a list that has already
   * scrolled away from its top (content keeps its own scrolling; only a
   * pull-down at the very top of a list dismisses, like native sheets).
   */
  const onSheetTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    if (isDesktop) return; // the desktop card is dragged by its title bar
    const touch = event.touches[0];
    const node = sheetRef.current;
    if (!touch || !node) return;
    const target = event.target as HTMLElement | null;
    // seeking keeps its own gesture
    if (target?.closest('[role="slider"]')) return;
    const rect = node.getBoundingClientRect();
    if (touch.clientY - rect.top > rect.height / 2) return; // bottom half = content's
    // nearest vertically scrolling ancestor — the sheet takes the pull-down
    // only when that list (if any) sits at its very top
    let scroller: HTMLElement | null = null;
    for (let el: HTMLElement | null = target; el && el !== node; el = el.parentElement) {
      const overflowY = window.getComputedStyle(el).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        scroller = el;
        break;
      }
    }
    if (scroller && scroller.scrollTop > 0) return;
    onStripTouchStart(event);
    scrollParentRef.current = scroller;
  };

  const onStripTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const start = dragStartY.current;
    const node = sheetRef.current;
    if (start === null || !node) return;
    // A list under the finger scrolling back up from below its top owns the
    // gesture — the sheet waits (it tracks the *net* displacement from the
    // start, so it picks up exactly where the finger is once the list is at
    // the top again).
    if (scrollParentRef.current && scrollParentRef.current.scrollTop > 0) return;
    const delta = (event.touches[0]?.clientY ?? start) - start;
    if (delta <= 0) {
      // dragging up does nothing (no rubber band), so the sheet stays put
      dragDistance.current = 0;
      node.style.transform = '';
      node.style.opacity = '';
      return;
    }
    draggedRef.current = true;
    dragDistance.current = delta;
    // Direct style writes instead of state: a re-render per touchmove would
    // repaint the whole player (lyrics list included) on every frame.
    node.style.transform = `translateY(${delta}px)`;
    node.style.opacity = String(Math.max(0.35, 1 - delta / 480));
  };

  const onStripTouchEnd = () => {
    const node = sheetRef.current;
    const distance = dragDistance.current;
    dragStartY.current = null;
    dragDistance.current = 0;
    scrollParentRef.current = null;
    // Hand the "was this a swipe?" flag over to the timestamp: the capture
    // handler below swallows the browser's synthesised click for a beat,
    // then every tap behaves normally again.
    if (draggedRef.current) swipeEndedAt.current = Date.now();
    draggedRef.current = false;
    if (distance > DISMISS_DISTANCE) {
      // Keep the dragged offset in place: the Dialog's slide-down exit now
      // takes the sheet out from wherever the finger let go instead of
      // springing back up first. The node unmounts with the exit, so the
      // next open starts clean.
      handleClose();
      return;
    }
    if (node) {
      node.style.transition = 'transform 240ms cubic-bezier(.2,.8,.2,1), opacity 240ms ease';
      node.style.transform = '';
      node.style.opacity = '';
    }
  };

  const onStripClick = () => {
    // the click a browser synthesises after a swipe must not close twice
    if (Date.now() - swipeEndedAt.current < 400) return;
    handleClose();
  };

  // A swipe over tappable content (title, cover, tabs) must not also fire
  // that element's tap action — the capture phase beats every descendant's
  // own click handler to it.
  const onSheetClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (Date.now() - swipeEndedAt.current < 400) event.stopPropagation();
  };

  // ── Pieces ─────────────────────────────────────────────────────────────

  /**
   * The handle strip: tap it, press Enter on it, or drag it down — all
   * three dismiss the sheet. It is a dedicated swipe zone (`touch-action:
   * none`), so a gesture that starts here moves the sheet instead of
   * scrolling the content underneath.
   */
  const strip = (
    <div
      role="button"
      tabIndex={0}
      aria-label="Close player"
      onClick={onStripClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handleClose();
        }
      }}
      onTouchStart={onStripTouchStart}
      onTouchMove={onStripTouchMove}
      onTouchEnd={onStripTouchEnd}
      className="relative z-[2] grid shrink-0 cursor-pointer place-items-center touch-none pb-1 pt-[max(10px,var(--sat))] focus-visible:rounded-[28px] focus-visible:[outline:2px_solid_var(--app-accent-fg)] focus-visible:[outline-offset:-2px]"
    >
      <div aria-hidden className="h-1 w-11 rounded-[56px] bg-disabled" />
    </div>
  );

  const header = (
    // No safe-area padding of its own: on a phone the handle strip above is
    // the sheet's topmost edge and already cleared the status bar (and on a
    // desktop the sheet is a centred card where `--sat` is 0px anyway).
    // Padding *both* stacked the inset and dropped the transport controls.
    <div className="relative z-[2] flex shrink-0 flex-row items-center gap-2 px-[10px] py-[6px]">
      <IconButton edge="start" aria-label="Close player" onClick={handleClose}>
        {isDesktop ? <CloseIcon /> : <ExpandMoreIcon />}
      </IconButton>
      {/* Phone: the centred eyebrow a full-screen player expects — pinned
          out of flow so the close/menu buttons never shift. */}
      <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 text-[11px] font-bold uppercase leading-[1.4] tracking-[0.16em] text-muted md:hidden">
        Now playing
      </span>
      <div className="flex-1" />
      {isDesktop && (
        <IconButton
          aria-label={fullScreen ? 'Exit full screen' : 'Full screen'}
          onClick={() => {
            void toggleFullScreen();
          }}
        >
          {fullScreen ? <ExitFullScreenIcon /> : <FullScreenIcon />}
        </IconButton>
      )}
      <PlayerMenu track={track} meta={meta} />
    </div>
  );

  /**
   * The cover — a large square tile (iPhone Music: ~20px radius, soft
   * shadow) centred in its column. The blurred circular halo that used
   * to bleed out from behind it is gone; the sheet's backdrop (and, on
   * desktop, the motion loop) carries the colour instead.
   */
  const artworkBox = (
    <div className={cn('relative mx-auto w-full', COVER_MAXW[coverSize])}>
      <Artwork
        src={artwork}
        alt={track.albumName || track.title}
        iconSize={72}
        style={{
          position: 'relative',
          zIndex: 1,
          width: '100%',
          aspectRatio: '1 / 1',
          borderRadius: 20,
          border: '1px solid var(--app-divider)',
          boxShadow: '0 24px 48px rgba(0,0,0,0.35)',
        }}
      />
      {/* "Cover" placement: the motion loop plays *inside* the tile, on top
          of the static poster, instead of any background surface. Same
          rounded corners as the artwork, same fade-in as the other layers. */}
      {motionUrl && motionPlacement === 'thumbnail' && (
        <video
          ref={coverVideoRef}
          src={motionUrl}
          autoPlay
          loop
          muted
          playsInline
          preload="metadata"
          onCanPlay={() => setMotionReady(true)}
          onError={() => setMotionReady(false)}
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[2] h-full w-full rounded-[20px] object-cover"
          style={{ opacity: motionReady ? 1 : 0, transition: 'opacity 400ms ease' }}
        />
      )}
      {player.buffering && (
        <Spinner
          size={44}
          color="inherit"
          className="absolute inset-0 z-[3] m-auto text-accent-fg"
        />
      )}
    </div>
  );

  /**
   * Title · explicit badge · artist · album — the metadata both layouts
   * share, left-aligned on both (Apple Music aligns left); only the
   * title's weight differs (hero `h5` on the phone, the `h6` that has
   * always sat beside the desktop columns).
   */
  const titleMeta = (titleVariant: 'h5' | 'h6') => (
    <>
      <div className="flex flex-row items-center justify-start gap-[6px] text-left">
        <MarqueeText text={track.title} variant={titleVariant} />
        {track.isExplicit && (
          <ExplicitIcon
            aria-label="Explicit"
            sx={{ fontSize: 18, color: 'text.secondary', flexShrink: 0 }}
          />
        )}
      </div>
      <p
        className={cn(
          'm-0 truncate text-sm leading-[1.43] text-muted hover:text-accent-fg',
          track.artist ? 'cursor-pointer' : 'cursor-default',
        )}
        role={track.artist ? 'link' : undefined}
        tabIndex={track.artist ? 0 : undefined}
        onClick={searchArtist}
        onKeyDown={(event) => {
          if (event.key === 'Enter') searchArtist();
        }}
      >
        {track.artist}
      </p>
      {track.albumName && (
        <span className="mt-[2px] block truncate text-xs leading-[1.4] text-disabled">
          {track.albumName}
        </span>
      )}
    </>
  );

  const titleBlock = (
    <div className="mt-4 flex flex-row items-center gap-2 text-left md:mt-2">
      <div className="min-w-0 flex-1">{titleMeta('h6')}</div>
    </div>
  );

  /**
   * Phone arrangement: the hero title with the heart riding its right
   * edge — Apple Music's placement, so the favourite is a thumb away from
   * the thing it favourites instead of hiding in the row below.
   */
  const mobileTitleBlock = (
    <div className="mt-4 flex items-center gap-1 text-left">
      <div className="min-w-0 flex-1">{titleMeta('h5')}</div>
      <NPFavorite track={track} />
    </div>
  );

  const errorAlert = player.error ? (
    <Alert severity="error" onClose={player.dismissError} className="mt-3 !py-0">
      {/* MIGRATION: the kit Alert has no `action` slot, and the kit Button
          has no `size="small"` / `color="inherit"` — the Retry button rides
          inside the message row with those metrics written as classes. */}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">{player.error}</span>
        <Button
          startIcon={<RefreshIcon fontSize="small" />}
          onClick={retry}
          className="shrink-0 !px-2 !py-1 !text-[0.8125rem] !text-white hover:!bg-white/10"
        >
          Retry
        </Button>
      </div>
    </Alert>
  ) : null;

  /**
   * Secondary row (desktop): the heart and the download, under the
   * transport. On a phone those two live elsewhere now — the heart rides
   * the title, the download sits in the labelled action bar — so this row
   * stops carrying the bare panel icons that used to live here.
   */
  const secondaryRow = (
    <div className="mt-2 flex flex-row items-center justify-center gap-1">
      <NPFavorite track={track} />
      <DownloadButton
        track={track}
        meta={meta}
        waitForCache={() => player.waitForCache(track.videoId)}
      />
    </div>
  );

  /**
   * Phone action bar: one segmented glass pill under the transport —
   * three labelled panel destinations (the bare icons they replaced were
   * far too quiet) and the download cell at the end, everything within a
   * thumb's arc.
   */
  const mobileActionBar = (
    <div className="mx-auto mt-3 flex w-full max-w-[440px] items-stretch overflow-hidden rounded-full border border-line bg-surface/60 backdrop-blur-xl">
      {[
        { label: 'Lyrics', Icon: LyricsIcon, tab: LYRICS_TAB },
        { label: 'Queue', Icon: QueueMusicIcon, tab: QUEUE_TAB },
        { label: 'Related', Icon: RelatedIcon, tab: RELATED_TAB },
      ].map(({ label, Icon, tab: value }) => (
        <button
          key={label}
          type="button"
          onClick={() => openPanel(value)}
          className={cn(
            'flex min-w-0 flex-1 items-center justify-center gap-1.5 px-2 py-3',
            'text-xs font-semibold text-muted',
            'transition-colors duration-150 hover:bg-hover hover:text-body active:scale-[0.98]',
            'focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2',
          )}
        >
          <Icon fontSize="small" className="shrink-0" />
          <span className="truncate">{label}</span>
        </button>
      ))}
      <div className="grid w-14 shrink-0 place-items-center border-l border-line">
        <DownloadButton
          track={track}
          meta={meta}
          waitForCache={() => player.waitForCache(track.videoId)}
        />
      </div>
    </div>
  );

  const scrubber = <NPScrubber onSeek={player.seek} />;

  /** Lyrics / queue / related, shared by the phone panel and the desktop column. */
  const panel = (
    <div className="flex min-h-0 flex-1 flex-col">
      <Tabs
        value={tab}
        onChange={onTabChange}
        variant="fullWidth"
        aria-label="Now playing panels"
        className="shrink-0 border-b border-line"
      >
        <Tab
          value={LYRICS_TAB}
          label="Lyrics"
          icon={<LyricsIcon />}
          iconPosition="start"
          className={TAB_CLASS}
        />
        <Tab
          value={QUEUE_TAB}
          label="Queue"
          icon={<QueueMusicIcon />}
          iconPosition="start"
          className={TAB_CLASS}
        />
        <Tab
          value={RELATED_TAB}
          label="Related"
          icon={<RelatedIcon />}
          iconPosition="start"
          className={TAB_CLASS}
        />
      </Tabs>
      <div className="relative mt-2 min-h-[220px] flex-1 overflow-hidden rounded-[20px] border border-line">
        {/* The animated cover, fitted edge-to-edge behind the lyrics under a
            theme-coloured scrim, so every line stays readable on top of
            moving pixels. Paints when the placement resolves to the lyrics
            background — the device default on a phone, or an explicit
            choice on any device. */}
        {tab === LYRICS_TAB && motionUrl && motionPlacement === 'lyrics' && (
          <>
            <video
              ref={panelVideoRef}
              src={motionUrl}
              autoPlay
              loop
              muted
              playsInline
              preload="metadata"
              onCanPlay={() => setMotionReady(true)}
              onError={() => setMotionReady(false)}
              aria-hidden
              className="pointer-events-none absolute inset-0 z-0 h-full w-full object-cover"
              style={{ opacity: motionReady ? 1 : 0, transition: 'opacity 400ms ease' }}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 z-[1]"
              style={{
                background: motionScrim,
                opacity: motionReady ? 1 : 0,
                transition: 'opacity 400ms ease',
              }}
            />
          </>
        )}
        {/* Lyrics mounts only while its tab is open: it measures real layout
            to centre the active line, which a display:none box cannot do. */}
        {tab === LYRICS_TAB && (
          <div className="relative z-[2] h-full">
            <LyricsView
              synced={lyrics.synced}
              unsynced={lyrics.unsynced}
              source={lyrics.source}
              loading={meta === null}
            />
          </div>
        )}
        {/* Queue and related stay mounted (hidden) so switching tabs never
            resets their scroll position or flickers a loading state. */}
        <div className={cn('h-full', tab === QUEUE_TAB ? 'block' : 'hidden')}>
          <NPQueue />
        </div>
        <div className={cn('h-full', tab === RELATED_TAB ? 'block' : 'hidden')}>
          <RelatedTab />
        </div>
      </div>
    </div>
  );

  const backdrop = effectsEnabled ? (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {artwork && (
        <Artwork
          src={artwork}
          alt=""
          icon={null}
          style={{
            position: 'absolute',
            top: '-25%',
            left: '-25%',
            width: '150%',
            height: '150%',
          }}
          imgStyle={{ filter: 'blur(70px) saturate(1.5)', opacity: 0.55 }}
        />
      )}
      <div
        className="absolute inset-0"
        style={{
          background: `linear-gradient(180deg, ${alpha('var(--app-bg)', 0.5)} 0%, ${alpha('var(--app-bg)', 0.88)} 45%, var(--app-bg) 100%)`,
        }}
      />
    </div>
  ) : null;

  // ── Phone: main view (cover → hero info → scrubber → transport → bar) ──
  const mobileMain = (
    // the column never scrolls: a stray scroll or swipe while reaching for
    // the scrubber thumb used to move the whole page under the finger.
    // `overflow-y-auto` alone also computes `overflow-x` to `auto`, which
    // is what let the sheet pan sideways — both axes are locked now. The
    // layout is sized to fit (the cover caps itself to a dynamic-viewport
    // budget that leaves room for the chrome below it), so the action
    // bar stays on screen even on a short phone; the bottom padding
    // clears the home indicator where the OS reports one
    <div className="relative z-[1] flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-[max(env(safe-area-inset-bottom),1rem)] pt-1">
      {artworkBox}
      {mobileTitleBlock}
      {errorAlert}
      {scrubber}
      <NPControls phone />
      <div className="mt-3">
        <VolumeSlider />
      </div>
      {mobileActionBar}
    </div>
  );

  // ── Phone: a panel has taken the screen over ───────────────────────────
  const mobilePanel = (
    <div className="relative z-[1] flex min-h-0 flex-1 flex-col px-4 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-2">
      {/* compact now-playing card: the song stays visible above the panel,
          and the down arrow folds everything back to the main view */}
      <div className="mb-1 flex shrink-0 flex-row items-center gap-3 rounded-2xl border border-line bg-surface px-[10px] py-2">
        <Artwork
          src={artwork}
          alt=""
          iconSize={20}
          style={{ width: 44, height: 44, borderRadius: 12, flexShrink: 0 }}
        />
        <div className="min-w-0 flex-1">
          <MarqueeText text={track.title} variant="subtitle2" />
          <span className="block truncate text-xs leading-[1.4] text-muted">
            {track.artist}
          </span>
        </div>
        <IconButton
          aria-label="Back to player"
          onClick={() => setPanelOpen(false)}
          className="border border-line"
        >
          <ExpandMoreIcon />
        </IconButton>
      </div>
      {panel}
    </div>
  );

  // ── Desktop: centred two-column dialog ─────────────────────────────────
  const desktopBody = (
    // the columns handle their own overflow — nothing ever escapes the
    // dialog itself
    <div className="relative z-[1] grid min-h-0 flex-1 grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-x-8 gap-y-4 overflow-hidden pb-6 md:px-8">
      {/* ── Left: cover, centred in its column ─────────────────────── */}
      <div className="flex min-h-0 min-w-0 items-center justify-center py-4">
        {artworkBox}
      </div>

      {/* ── Right: info → scrubber → transport → panels ─────────────── */}
      {/* no scrolling on the column itself (neither axis): gestures aimed
          at the scrubber thumb must never move the page. Only the
          lyrics / queue / related lists scroll, inside their own boxes */}
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden pr-1">
        {titleBlock}
        {errorAlert}
        {scrubber}
        <NPControls />
        <div className="mt-3">
          <VolumeSlider />
        </div>
        {secondaryRow}
        <div className="mt-3 flex min-h-[240px] flex-1 flex-col">
          {panel}
        </div>
      </div>
    </div>
  );

  // ── Desktop: cinematic full screen ─────────────────────────────────────
  // Full screen with every affordance gone: the song's details (no
  // scrubber), the lyrics in full, and the artwork backdrop carrying the
  // colour. No buttons, no tabs, no close control — Esc leaves (see
  // `handleClose`), which is the whole point of the mode. The cover keeps
  // its place on the left unless Settings → Cover in cinematic mode is off.
  const cinematicDetails = (
    // Centered block — tucked directly under the cover in the left column,
    // or on top when the cover is hidden. Capped so a huge display doesn't
    // stretch it.
    <div className="mx-auto w-full max-w-[720px] shrink-0 text-center">
      <div className="flex min-w-0 items-center justify-center gap-[6px]">
        <MarqueeText text={track.title} variant="h5" />
        {track.isExplicit && (
          <ExplicitIcon
            aria-label="Explicit"
            sx={{ fontSize: 18, color: 'text.secondary', flexShrink: 0 }}
          />
        )}
      </div>
      <p className="m-0 truncate text-base leading-[1.43] text-muted">
        {track.artist}
        {track.albumName ? ` — ${track.albumName}` : ''}
      </p>
    </div>
  );

  const cinematicLyrics = (
    <LyricsView
      synced={lyrics.synced}
      unsynced={lyrics.unsynced}
      source={lyrics.source}
      loading={meta === null}
    />
  );

  const cinematicBody = cinematicCover ? (
    // Cover on the left with the song's details tucked directly under it;
    // the lyrics take the right column in full.
    <div className="relative z-[1] grid min-h-0 flex-1 grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-x-8 overflow-hidden pb-8 md:px-10">
      <div className="flex min-h-0 min-w-0 flex-col items-center justify-center gap-4 py-4">
        {artworkBox}
        {cinematicDetails}
      </div>
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        {cinematicLyrics}
      </div>
    </div>
  ) : (
    // Cover hidden by choice — details centred on top, lyrics full width.
    <div className="relative z-[1] flex min-h-0 flex-1 flex-col items-center overflow-hidden px-10 pb-8 pt-6">
      {cinematicDetails}
      <div className="mt-5 min-h-0 w-full max-w-[860px] flex-1">{cinematicLyrics}</div>
    </div>
  );

  // The header's close + full-screen buttons are the affordances cinematic
  // mode exists to remove — the whole strip disappears with them.
  const showHeader = !cinematic && (isDesktop || !panelOpen);

  // MIGRATION: `fullScreen` / `TransitionComponent` / `PaperProps` have no
  // kit equivalents — the kit Dialog animates the layer itself (a short
  // fade-and-rise instead of the old bottom `Slide`), and the paper's shape
  // lives in `className`: window-filling below `md`, the centred
  // `min(1120px, 100vw − 64px)` × `min(760px, 100vh − 64px)` card above.
  return (
    <Dialog
      open={player.sheetOpen}
      onClose={handleClose}
      aria-label="Now playing"
      // Phone: the sheet now *leaves downward* on close (matching the drag
      // that usually dismisses it); the desktop card keeps the shared fade.
      slideFromBottom={!isDesktop}
      className={cn(
        // `shrink-0` is what makes the phone sheet truly edge-to-edge: the
        // dialog wrapper is a padded flexbox, and a `w-screen` item would
        // otherwise shrink into its padding, leaving a dim strip of the page
        // showing through on both sides.
        '!h-[100dvh] !w-screen !max-h-none !max-w-none !rounded-none !bg-bg shrink-0',
        // Desktop sizes the card down to a panel — unless full screen is on,
        // where it takes the whole viewport (same as the phone sheet).
        !fullScreen &&
          'md:!h-[min(760px,calc(100vh_-_64px))] md:!w-[min(1120px,calc(100vw_-_64px))] md:!rounded-[20px]',
      )}
    >
      <div
        ref={sheetRef}
        className="relative flex h-full min-h-0 flex-col"
        // Phone: the top half of the sheet is a dismiss zone — a swipe that
        // begins there drags the sheet like the handle strip does (see
        // onSheetTouchStart); desktop is left to its own devices.
        onTouchStart={onSheetTouchStart}
        onTouchMove={onStripTouchMove}
        onTouchEnd={onStripTouchEnd}
        onTouchCancel={onStripTouchEnd}
        onClickCapture={onSheetClickCapture}
      >
        {backdrop}
        {/* The motion cover spans the whole Now Playing card — one fitted
            video under the shared scrim, painted above the backdrop but
            below every piece of body/header content. Paints when the
            placement resolves to the player background — the device
            default on desktop, or an explicit choice on any device.
            Cinematic mode also borrows the lyrics placement: with no
            card layer of its own to sit in, the loop becomes the stage. */}
        {motionUrl &&
          (motionPlacement === 'player' ||
            (cinematic && motionPlacement === 'lyrics')) && (
          <>
            <video
              ref={cardVideoRef}
              src={motionUrl}
              autoPlay
              loop
              muted
              playsInline
              preload="metadata"
              onCanPlay={() => setMotionReady(true)}
              onError={() => setMotionReady(false)}
              aria-hidden
              className="pointer-events-none absolute inset-0 z-0 h-full w-full object-cover"
              style={{ opacity: motionReady ? 1 : 0, transition: 'opacity 400ms ease' }}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 z-[1]"
              style={{
                background: motionScrim,
                opacity: motionReady ? 1 : 0,
                transition: 'opacity 400ms ease',
              }}
            />
          </>
        )}
        {!isDesktop && strip}
        {showHeader && header}
        {isDesktop ? (cinematic ? cinematicBody : desktopBody) : panelOpen ? mobilePanel : mobileMain}
      </div>
    </Dialog>
  );
}
