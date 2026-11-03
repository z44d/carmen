import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type CSSProperties, type FormEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { apiGet } from '../api';
import { useIsDesktop } from '../hooks';
import { usePlayer } from '../player/PlayerContext';
import { loadSearchHistory, rememberSearch } from '../utils/searchHistory';
import { mergeSuggestionEntries, suggestionTextOf, type SuggestionEntry } from '../utils/searchSuggestions';
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
  GitHubIcon,
  HistoryIcon,
  HomeIcon,
  LibraryIcon,
  QueueListIcon,
  SearchIcon,
  SettingsIcon,
} from './icons';

/** One entry of the primary navigation. */
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

/** Phone bottom navigation: everything except Queue (the header keeps it). */
const BOTTOM_NAV_ITEMS: NavItem[] = NAV_ITEMS.filter((item) => item.path !== '/queue');

/** Header bar height below the status-bar inset (the hero pulls up by this). */
const HEADER_PX = 64;

/** Height of the phone bottom navigation bar (safe-area padding extra). */
const BOTTOM_NAV_PX = 56;

/** The app logo (SVG master in `frontend/public/`; PNG renders ship alongside). */
const LOGO_SRC = `${import.meta.env.BASE_URL}logo.svg`;

/** The upstream repository, linked from the bottom of the sidebar. */
const REPO_URL = 'https://github.com/z44d/carmen';

/** Circular dark-glass header button (Queue). */
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
 * wordmark) — the wide glass search pill in the middle, and the circular
 * glass Queue button on the right on phones only. The search pill
 * takes ⌘K / Ctrl+K focus and Enter navigates to the search page.
 * Typing opens a glass suggestions dropdown under the pill (server
 * suggestions plus matching recent searches, keyboard-navigable);
 * on /search, typing debounced-updates the URL so results run live
 * while the header — outside `<Outlet/>` — keeps focus. The pill
 * itself is visually unchanged, and the dropdown is absolutely
 * positioned, so opening it never moves the layout.
 * Every other section lives in the bottom navigation (phone) or the
 * permanent sidebar (desktop).
 */
function AppHeader() {
  const navigate = useNavigate();
  const location = useLocation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [term, setTerm] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [history, setHistory] = useState<string[]>(() => loadSearchHistory());
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const onSearchPage = location.pathname === '/search';

  // Keep the pill in sync with an arrived search (deep link / artist
  // jump). Guard: while the pill is focused and the user has already
  // typed past the URL query, the typed text wins — the debounced URL
  // update below catches up with it instead of clobbering it.
  useEffect(() => {
    if (location.pathname !== '/search') return;
    const query = new URLSearchParams(location.search).get('query') || '';
    setTerm((current) => {
      if (
        document.activeElement === inputRef.current &&
        query &&
        current.startsWith(query) &&
        current.length > query.length
      ) {
        return current;
      }
      return query;
    });
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

  // Debounced server suggestions for the typed term.
  useEffect(() => {
    const trimmed = term.trim();
    if (!trimmed) {
      setSuggestions([]);
      setActiveIndex(-1);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      apiGet('/search/suggestions', { query: trimmed })
        .then((payload) => {
          const list = Array.isArray(payload)
            ? payload.map((entry: unknown) => suggestionTextOf(entry)).filter(Boolean)
            : [];
          setSuggestions(list);
        })
        .catch(() => setSuggestions([]));
    }, 220);
    return () => window.clearTimeout(timer);
  }, [term]);

  // On /search, typing debounced-updates the URL (replace) so the
  // URL-driven results run live while the header keeps focus. Off
  // /search, typing only feeds the dropdown; Enter/selection navigates.
  useEffect(() => {
    if (!onSearchPage) return undefined;
    const trimmed = term.trim();
    const timer = window.setTimeout(() => {
      const current = new URLSearchParams(location.search).get('query') || '';
      if (trimmed === current) return;
      const next = new URLSearchParams(location.search);
      if (trimmed) next.set('query', trimmed);
      else next.delete('query');
      navigate({ pathname: '/search', search: next.toString() }, { replace: true });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [term, onSearchPage, location.search, navigate]);

  const entries: SuggestionEntry[] = useMemo(
    () => mergeSuggestionEntries(history, suggestions, term),
    [history, suggestions, term],
  );

  const select = (text: string) => {
    const query = text.trim();
    if (!query) return;
    setTerm(query);
    setHistory(rememberSearch(query));
    setDropdownOpen(false);
    setActiveIndex(-1);
    navigate(`/search?query=${encodeURIComponent(query)}`);
    inputRef.current?.blur();
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const query = term.trim();
    setDropdownOpen(false);
    setActiveIndex(-1);
    if (query) setHistory(rememberSearch(query));
    navigate(query ? `/search?query=${encodeURIComponent(query)}` : '/search');
    inputRef.current?.blur();
  };

  const closeSoon = () => {
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => setDropdownOpen(false), 150);
  };

  return (
    <header className="pointer-events-none fixed inset-x-0 top-0 z-[1100] md:left-[72px]">
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
        <form
          onSubmit={submit}
          role="search"
          className="pointer-events-auto relative min-w-0 flex-1 md:mx-auto md:max-w-[560px]"
        >
          <div className="glass-pill flex h-11 items-center gap-2 rounded-full px-3.5 shadow-glass transition focus-within:border-white/40">
            <SearchIcon fontSize="small" className="shrink-0 opacity-80" />
            <input
              ref={inputRef}
              type="search"
              value={term}
              onChange={(event) => {
                setTerm(event.target.value);
                setDropdownOpen(true);
                setActiveIndex(-1);
              }}
              onFocus={() => {
                window.clearTimeout(closeTimerRef.current);
                setHistory(loadSearchHistory());
                setDropdownOpen(true);
              }}
              onBlur={closeSoon}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  if (!entries.length) return;
                  setDropdownOpen(true);
                  setActiveIndex((index) => (index + 1) % entries.length);
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  if (!entries.length) return;
                  setDropdownOpen(true);
                  setActiveIndex((index) => (index - 1 + entries.length) % entries.length);
                } else if (event.key === 'Enter' && activeIndex >= 0 && entries[activeIndex]) {
                  event.preventDefault();
                  select(entries[activeIndex].text);
                } else if (event.key === 'Escape') {
                  setDropdownOpen(false);
                  setActiveIndex(-1);
                }
              }}
              placeholder="Search songs, albums, artists…"
              aria-label="Search songs, albums, artists"
              role="combobox"
              aria-expanded={dropdownOpen && entries.length > 0}
              aria-controls="header-search-suggestions"
              aria-activedescendant={
                activeIndex >= 0 ? `header-suggestion-${activeIndex}` : undefined
              }
              aria-autocomplete="list"
              className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none"
            />
            <kbd className="hidden shrink-0 items-center rounded-md border border-white/25 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white/80 sm:flex">
              ⌘K
            </kbd>
          </div>
          {dropdownOpen && entries.length > 0 && (
            <div
              id="header-search-suggestions"
              role="listbox"
              aria-label="Search suggestions"
              className="glass-pill absolute left-0 right-0 top-full z-[1300] mt-2 max-h-[60vh] overflow-y-auto rounded-[20px] shadow-glass"
            >
              <ul className="m-0 list-none p-1.5">
                {entries.map((entry, index) => (
                  <li
                    key={`${entry.kind}:${entry.text}`}
                    id={`header-suggestion-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => select(entry.text)}
                    className={cn(
                      'flex cursor-pointer items-center gap-2.5 rounded-[14px] px-3 py-2.5 text-sm text-white transition hover:bg-white/10',
                      index === activeIndex && 'bg-white/10',
                    )}
                  >
                    {entry.kind === 'history' ? (
                      <HistoryIcon fontSize="small" className="shrink-0 opacity-80" />
                    ) : (
                      <SearchIcon fontSize="small" className="shrink-0 opacity-80" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{entry.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </form>
        <div className="pointer-events-auto flex shrink-0 items-center">
          {/* Phones only: Queue lives in the sidebar on desktop. */}
          <GlassIconButton label="Queue" onClick={() => navigate('/queue')} className="md:hidden">
            <QueueListIcon />
          </GlassIconButton>
        </div>
      </div>
    </header>
  );
}

/**
 * Phone bottom navigation: Home / Search / Library / Settings, evenly
 * spread, glass, clearing the home-indicator safe area. Queue stays in
 * the header — four items is the whole bar.
 */
function BottomNav() {
  const location = useLocation();
  const effectsEnabled = useEffectsEnabled();
  return (
    <nav
      aria-label="Primary"
      className={cn(
        'fixed inset-x-0 bottom-0 z-[1200] border-t border-line shadow-glass md:hidden',
        effectsEnabled ? 'bg-surface/86' : 'bg-surface',
      )}
      style={{
        backdropFilter: effectsEnabled ? 'blur(20px) saturate(1.6)' : 'none',
        WebkitBackdropFilter: effectsEnabled ? 'blur(20px) saturate(1.6)' : 'none',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <div className="grid grid-cols-4" style={{ height: BOTTOM_NAV_PX }}>
        {BOTTOM_NAV_ITEMS.map(({ label, path, icon: Icon }) => {
          const active = location.pathname === path;
          return (
            <NavLink
              key={path}
              to={path}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex flex-col items-center justify-center gap-0.5 no-underline transition-colors focus-visible:outline-2 focus-visible:outline-accent',
                active ? 'text-accent-fg' : 'text-muted hover:text-body',
              )}
            >
              <Icon fontSize="small" className="shrink-0" />
              <span className="text-[11px] font-semibold leading-none">{label}</span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * Permanent desktop sidebar: an icon-only rail — the logo, the five
 * sections as icon buttons, and the GitHub link at the bottom. Full
 * height, fixed 72px width, glass — the content column shifts right by
 * its width (see `Layout`). Labels stay available to assistive tech and
 * as hover tooltips; nothing else on desktop shows section text.
 */
function Sidebar() {
  const location = useLocation();
  const effectsEnabled = useEffectsEnabled();
  return (
    <aside
      aria-label="Primary"
      className={cn(
        'fixed bottom-0 left-0 top-0 z-[1200] hidden w-[72px] flex-col items-center border-r border-line shadow-glass md:flex',
        effectsEnabled ? 'bg-surface/86' : 'bg-surface',
      )}
      style={{
        backdropFilter: effectsEnabled ? 'blur(20px) saturate(1.6)' : 'none',
        WebkitBackdropFilter: effectsEnabled ? 'blur(20px) saturate(1.6)' : 'none',
      }}
    >
      <div className="flex items-center justify-center pb-2 pt-[max(20px,var(--sat))]">
        <img
          src={LOGO_SRC}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="h-9 w-9 shrink-0 rounded-[11px]"
        />
      </div>
      <nav aria-label="Primary" className="flex flex-col items-center gap-1 pt-3">
        {NAV_ITEMS.map(({ label, path, icon: Icon }) => {
          const active = location.pathname === path;
          return (
            <NavLink
              key={path}
              to={path}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              title={label}
              className={cn(
                'flex h-12 w-12 items-center justify-center rounded-full text-[15px] font-semibold no-underline transition-colors focus-visible:outline-2 focus-visible:outline-accent',
                active
                  ? 'bg-accent/15 text-accent-fg'
                  : 'text-body hover:bg-hover',
              )}
            >
              <Icon className="shrink-0" />
              <span className="sr-only">{label}</span>
            </NavLink>
          );
        })}
      </nav>
      <div className="mt-auto flex flex-col items-center gap-3 pb-[max(20px,env(safe-area-inset-bottom))] pt-4">
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          aria-label="Carmen on GitHub"
          title="Carmen on GitHub"
          className="flex h-12 w-12 items-center justify-center rounded-full border-t border-line text-muted no-underline transition-colors hover:text-body focus-visible:outline-2 focus-visible:outline-accent"
        >
          <GitHubIcon fontSize="small" className="shrink-0" />
        </a>
      </div>
    </aside>
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

/** App shell: floating header, sidebar / bottom nav, docked mini player, full player, snackbars. */
export default function Layout() {
  const player = usePlayer();
  const location = useLocation();
  const isDesktop = useIsDesktop();
  const showMini = Boolean(player.current);
  // Low battery mode: no ambient artwork layer, no glass surfaces —
  // plain solid ones instead (see useEffectsEnabled). The ambient wash
  // additionally has its own Settings choice (artwork background).
  const effectsEnabled = useEffectsEnabled();
  const artworkBackground = useArtworkBackground();

  // The mini player docks above the phone bottom nav (nav height + a
  // finger's gap, past the home-indicator inset); on desktop it keeps
  // its old 16px float.
  const bottomOffset = showMini
    ? `calc(env(safe-area-inset-bottom) + ${isDesktop ? 16 : BOTTOM_NAV_PX + 12}px)`
    : '0px';

  // Content reserves room for the mini player and, on phones, the
  // bottom nav under it — nothing scrolls underneath either bar.
  const contentPaddingBottom = isDesktop
    ? `calc(${showMini ? 92 : 24}px + env(safe-area-inset-bottom))`
    : `calc(${showMini ? 140 : BOTTOM_NAV_PX + 20}px + env(safe-area-inset-bottom))`;

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

      <AppHeader />
      <Sidebar />
      <BottomNav />

      {/* The content column shifts right by the sidebar width on
          desktop (the sidebar itself is fixed); the home hero's negative
          top margin is untouched by the horizontal shift. */}
      <div className="flex min-w-0 flex-1 flex-col md:pl-[72px]">
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

      {/* the docked bar would sit under the desktop player sheet, so it
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
