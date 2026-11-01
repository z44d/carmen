import { useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type CSSProperties, type FormEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';

import { useIsDesktop } from '../hooks';
import { usePlayer } from '../player/PlayerContext';
import SmartDownloadWatcher from '../offline/smartDownload';
import { useArtworkBackground, useEffectsEnabled } from '../settings/store';
import { clearNotice, getDownloadsSnapshot, subscribeDownloads } from '../utils/downloadsStore';
import { cn } from '../utils/cn';
import AmbientBackground from './AmbientBackground';
import MiniPlayer from './MiniPlayer';
import PlayerSheet from './PlayerSheet';
import type { SvgIconProps } from './SvgIcon';
import { Alert, Snackbar } from './ui';
import {
  CloseIcon,
  HomeIcon,
  LibraryIcon,
  MenuIcon,
  QueueListIcon,
  SearchIcon,
  SettingsIcon,
} from './icons';

/** One entry of the primary navigation (slide-in drawer). */
interface NavItem {
  label: string;
  path: string;
  icon: ComponentType<SvgIconProps>;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Home', path: '/', icon: HomeIcon },
  { label: 'Search', path: '/search', icon: SearchIcon },
  { label: 'Queue', path: '/queue', icon: QueueListIcon },
  { label: 'Library', path: '/library', icon: LibraryIcon },
  { label: 'Settings', path: '/settings', icon: SettingsIcon },
];

/** Header bar height below the status-bar inset (the hero pulls up by this). */
const HEADER_PX = 64;

/** The app logo, served from `frontend/public/`. */
const LOGO_SRC = `${import.meta.env.BASE_URL}logo.png`;

/** Circular dark-glass header button (hamburger / Queue / Library). */
function GlassIconButton({
  label,
  onClick,
  children,
  className,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'glass-pill grid size-11 shrink-0 place-items-center rounded-full shadow-glass transition hover:brightness-125 focus-visible:outline-2 focus-visible:outline-white active:scale-[0.94]',
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * Floating app header: a transparent overlay row (no solid bar, no
 * wordmark) — circular glass hamburger left, wide glass search pill in the
 * middle, circular glass Queue / Library buttons right. The search pill
 * takes ⌘K / Ctrl+K focus and Enter navigates to the search page. The
 * hamburger opens the slide-in glass drawer below.
 */
function AppHeader({
  onOpenDrawer,
}: {
  onOpenDrawer: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [term, setTerm] = useState('');

  // Keep the pill in sync with an arrived search (deep link / artist jump).
  useEffect(() => {
    if (location.pathname !== '/search') return;
    const query = new URLSearchParams(location.search).get('query') || '';
    setTerm(query);
  }, [location.pathname, location.search]);

  // ⌘K / Ctrl+K focuses the pill from anywhere in the app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const query = term.trim();
    navigate(query ? `/search?query=${encodeURIComponent(query)}` : '/search');
    inputRef.current?.blur();
  };

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-[1100]">
      {/* readability gradient over the hero backdrop — the pills carry
          their own glass, this only keeps the top edge legible */}
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-b from-black/45 to-transparent"
      />
      <div
        className="relative flex h-16 items-center gap-2 px-3 sm:gap-2.5 sm:px-4"
        style={{ paddingTop: 'var(--sat)', height: `calc(${HEADER_PX}px + var(--sat))` }}
      >
        <div className="pointer-events-auto flex shrink-0 items-center">
          <GlassIconButton label="Open menu" onClick={onOpenDrawer}>
            <MenuIcon />
          </GlassIconButton>
        </div>
        <form
          onSubmit={submit}
          role="search"
          className="pointer-events-auto min-w-0 flex-1 md:mx-auto md:max-w-[560px]"
        >
          <div className="glass-pill flex h-11 items-center gap-2 rounded-full px-3.5 shadow-glass transition focus-within:border-white/40">
            <SearchIcon fontSize="small" className="shrink-0 opacity-80" />
            <input
              ref={inputRef}
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Search songs, albums, artists…"
              aria-label="Search songs, albums, artists"
              className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none"
            />
            <kbd className="hidden shrink-0 items-center rounded-md border border-white/25 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white/80 sm:flex">
              ⌘K
            </kbd>
          </div>
        </form>
        <div className="pointer-events-auto flex shrink-0 items-center gap-2">
          <GlassIconButton label="Queue" onClick={() => navigate('/queue')}>
            <QueueListIcon />
          </GlassIconButton>
          <GlassIconButton
            label="Library"
            onClick={() => navigate('/library')}
            className="hidden sm:grid"
          >
            <LibraryIcon />
          </GlassIconButton>
        </div>
      </div>
    </header>
  );
}

/** Slide-in glass drawer: nav items, brand at the bottom. */
function NavDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const location = useLocation();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            aria-hidden
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="fixed inset-0 z-[1240] bg-black/60 backdrop-blur-[2px]"
          />
          <motion.aside
            role="dialog"
            aria-label="Menu"
            aria-modal="true"
            initial={{ x: '-104%' }}
            animate={{ x: 0 }}
            exit={{ x: '-104%' }}
            transition={{ type: 'tween', duration: 0.26, ease: [0.2, 0.8, 0.2, 1] }}
            className="fixed bottom-0 left-0 top-0 z-[1250] flex w-[300px] max-w-[84vw] flex-col border-r border-line bg-surface shadow-glass"
          >
            <div className="flex items-center gap-3 px-5 pb-2 pt-[max(20px,var(--sat))]">
              <img
                src={LOGO_SRC}
                alt=""
                aria-hidden="true"
                draggable={false}
                className="h-9 w-9 shrink-0 rounded-[11px]"
              />
              <span className="min-w-0 flex-1 text-lg font-extrabold tracking-tight">Carmen</span>
              <button
                type="button"
                aria-label="Close menu"
                onClick={onClose}
                className="grid size-10 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-hover hover:text-body focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.94]"
              >
                <CloseIcon />
              </button>
            </div>
            <nav aria-label="Primary" className="flex flex-col gap-1 px-3 pt-3">
              {NAV_ITEMS.map(({ label, path, icon: Icon }) => {
                const active = location.pathname === path;
                return (
                  <NavLink
                    key={path}
                    to={path}
                    onClick={onClose}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-3 rounded-full px-4 py-3 text-[15px] font-semibold no-underline transition-colors focus-visible:outline-2 focus-visible:outline-accent',
                      active
                        ? 'bg-accent/15 text-accent-fg'
                        : 'text-body hover:bg-hover',
                    )}
                  >
                    <Icon className="shrink-0" />
                    {label}
                  </NavLink>
                );
              })}
            </nav>
            <div className="mt-auto px-5 pb-[max(20px,env(safe-area-inset-bottom))]">
              <p className="m-0 border-t border-line pt-4 text-[13px] leading-[1.4] text-muted">
                Your music, everywhere.
              </p>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function NoticeSnackbars() {
  const { notice } = useSyncExternalStore(subscribeDownloads, getDownloadsSnapshot, getDownloadsSnapshot);
  const player = usePlayer();

  return (
    <>
      <Snackbar
        key={notice?.id}
        open={Boolean(notice)}
        autoHideDuration={4000}
        onClose={clearNotice}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={notice?.severity || 'info'} variant="filled" onClose={clearNotice} className="w-full">
          {notice?.message}
        </Alert>
      </Snackbar>

      <Snackbar
        open={Boolean(player.error) && !player.sheetOpen}
        autoHideDuration={6000}
        onClose={player.dismissError}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert severity="error" variant="filled" onClose={player.dismissError}>
          {player.error}
        </Alert>
      </Snackbar>
    </>
  );
}

/** App shell: floating header, drawer, docked mini player, full player, snackbars. */
export default function Layout() {
  const player = usePlayer();
  const location = useLocation();
  const isDesktop = useIsDesktop();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const showMini = Boolean(player.current);
  // Low battery mode: no ambient artwork layer, no glass surfaces —
  // plain solid ones instead (see useEffectsEnabled). The ambient wash
  // additionally has its own Settings choice (artwork background).
  const effectsEnabled = useEffectsEnabled();
  const artworkBackground = useArtworkBackground();

  // No bottom tab bar anymore: the mini player floats 12–16px above the
  // bottom edge on every width, and content only reserves room for it.
  const bottomOffset = showMini
    ? `calc(env(safe-area-inset-bottom) + ${isDesktop ? 16 : 12}px)`
    : '0px';

  const contentPaddingBottom = isDesktop
    ? `calc(${showMini ? 92 : 24}px + env(safe-area-inset-bottom))`
    : `calc(${showMini ? 84 : 20}px + env(safe-area-inset-bottom))`;

  // Every navigation starts at the top. `<main>` is the app's only scroller,
  // so it keeps its position across routes — without this, opening Queue,
  // Search or Settings landed wherever Home was left scrolled. Query-only
  // changes (a new search term on the same page) deliberately keep the
  // position: the view itself never changed.
  const scrollerRef = useRef<HTMLElement | null>(null);
  const lastPathname = useRef(location.pathname);
  useEffect(() => {
    if (lastPathname.current === location.pathname) return;
    lastPathname.current = location.pathname;
    scrollerRef.current?.scrollTo(0, 0);
  }, [location.pathname]);

  return (
    // Fixed-height app window: the root never scrolls (styles.css locks
    // html/body/#root), only `<main>` below does — no rubber-banding, no
    // horizontal document overflow, header pinned as an overlay.
    // `--app-header` is the clearance every page clears and the home hero
    // pulls back up by, so its backdrop reaches the viewport top.
    <div
      className="flex h-dvh overflow-hidden"
      style={{ '--app-header': `calc(var(--sat) + ${HEADER_PX}px)` } as CSSProperties}
    >
      {/* artwork driven ambient tint (painted behind every surface) —
          low battery mode and the Settings choice skip it entirely */}
      {effectsEnabled && artworkBackground && <AmbientBackground />}

      <AppHeader onOpenDrawer={() => setDrawerOpen(true)} />
      <NavDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* the app's single vertical scroller — pages lay out inside it;
            `id="app-main"` lets HomePage's pull-to-refresh read its position.
            Top padding clears the floating header; the home hero cancels
            exactly this amount with a negative margin (see HomePage). */}
        <main
          id="app-main"
          ref={scrollerRef}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain"
          style={{ paddingTop: 'var(--app-header)', paddingBottom: contentPaddingBottom }}
        >
          <Outlet />
        </main>
      </div>

      {/* the docked bar would sit under the desktop player drawer, so it
          steps aside while the player is open */}
      {!(isDesktop && player.sheetOpen) && <MiniPlayer bottomOffset={bottomOffset} />}

      <PlayerSheet />
      <NoticeSnackbars />
      {/* paint-less playhead watcher for the smart-downloads rule — kept as
          its own leaf so the shell never re-renders on playback ticks */}
      <SmartDownloadWatcher />
    </div>
  );
}
