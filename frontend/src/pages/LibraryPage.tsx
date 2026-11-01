/**
 * Library — an Apple Music style tabbed hub: one sticky tab bar (Songs,
 * Favorites, Artists, Albums, Playlists, Recent) with exactly one page mounted
 * below it, so a tab switch unmounts the page behind it instead of stacking
 * every section on one long scroll.
 *
 * The selected tab is mirrored into `sessionStorage` — deliberately not the
 * app-state DB row, so hopping to a collection and back (or a route restore)
 * keeps the tab while a fresh launch defaults to Songs.
 *
 * Selecting a playlist still swaps the content area for an in-page detail
 * view instead of a route (the route stays `/library`), so closing it
 * remounts the Playlists page and it reloads its data on its own.
 */
import { useCallback, useEffect, useState } from 'react';

import { Container } from '../components/ui';
import { listDownloads } from '../db/repos/downloads';
import type { DownloadedSong } from '../types/models';
import AlbumsSection from './library/AlbumsSection';
import ArtistsSection from './library/ArtistsSection';
import FavoritesSection from './library/FavoritesSection';
import PlaylistsSection from './library/PlaylistsSection';
import PlaylistDetailView from './library/PlaylistDetailView';
import RecentSection from './library/RecentSection';
import SongsSection from './library/SongsSection';

/** The six Library tabs, in display order. */
const TAB_IDS = ['songs', 'favorites', 'artists', 'albums', 'playlists', 'recent'] as const;
type LibraryTab = (typeof TAB_IDS)[number];

const TAB_LABELS: Record<LibraryTab, string> = {
  songs: 'Songs',
  favorites: 'Favorites',
  artists: 'Artists',
  albums: 'Albums',
  playlists: 'Playlists',
  recent: 'Recent',
};

/** Session-scoped key — no DB table / setting for a view preference. */
const TAB_STORAGE_KEY = 'carmen.library.tab';

/** Restores the last tab, falling back to Songs (also on blocked storage). */
function readStoredTab(): LibraryTab {
  try {
    const stored = sessionStorage.getItem(TAB_STORAGE_KEY);
    if (stored && (TAB_IDS as readonly string[]).includes(stored)) return stored as LibraryTab;
  } catch {
    // storage can be unavailable (private mode / hardened webview) — default.
  }
  return 'songs';
}

export default function LibraryPage() {
  const [tab, setTab] = useState<LibraryTab>(readStoredTab);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [downloads, setDownloads] = useState<DownloadedSong[]>([]);
  const [downloadsLoading, setDownloadsLoading] = useState(true);

  // One read of the offline catalogue feeds the Albums & Artists grouping;
  // the Songs page runs its own sorted query and the detail view swaps the
  // content area (remounting the pages behind it when it closes).
  //
  // Started on first arrival on a catalogue tab and kept here rather than
  // inside the pages, so Albums ↔ Artists reuses the same data. No
  // cancellation guard: a write landing after a navigation is a harmless
  // no-op in React 18, and re-entering the tabs simply re-runs the effect
  // (fresh data, like the old per-section loads).
  const wantsCatalogue = tab === 'albums' || tab === 'artists';
  useEffect(() => {
    if (!wantsCatalogue) return;
    setDownloadsLoading(true);
    listDownloads()
      .then((rows) => {
        setDownloads(rows);
        setDownloadsLoading(false);
      })
      .catch((loadError) => {
        console.warn('[library] load catalogue failed', loadError);
        setDownloadsLoading(false);
      });
  }, [wantsCatalogue]);

  // Stable identity: the detail view keys its load effect on this callback.
  const handleBack = useCallback(() => setSelectedId(null), []);

  const selectTab = useCallback((next: LibraryTab) => {
    setTab(next);
    // Switching tabs dismisses an open playlist detail — the detail belongs
    // to the Playlists page that launched it.
    setSelectedId(null);
    try {
      sessionStorage.setItem(TAB_STORAGE_KEY, next);
    } catch {
      // Persisting is best-effort; the tab still works for this session.
    }
  }, []);

  // MIGRATION: the kit Tabs strip became Lumi pills below — same tab ids,
  // same sessionStorage behaviour, no underline strip.
  const handleTabChange = (next: LibraryTab) => {
    selectTab(next);
  };

  return (
    <Container maxWidth="lg" className="!px-0 pb-8 pt-4 md:pb-12 md:pt-6">
      <div className="px-4 md:px-10">
        <h5 className="m-0 text-[26px] font-extrabold leading-[1.2] tracking-[-0.01em]">Library</h5>
        <span className="mt-0.5 block text-[13px] leading-[1.4] text-muted">
          Playlists, downloads and collections on this device
        </span>
      </div>

      {/* Lumi pill strip: horizontally scrollable, active pill is the
          body colour filled (white on dark, near-black on light). */}
      <div
        role="tablist"
        aria-label="Library sections"
        className="lumi-row mt-5 flex gap-2 overflow-x-auto px-4 pb-1 md:px-10"
      >
        {TAB_IDS.map((id) => {
          const selected = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => handleTabChange(id)}
              className={
                selected
                  ? 'h-9 shrink-0 rounded-full bg-body px-4 text-sm font-bold text-bg transition-colors focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.97]'
                  : 'h-9 shrink-0 rounded-full border border-line px-4 text-sm font-semibold text-muted transition-colors hover:text-body focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.97]'
              }
            >
              {TAB_LABELS[id]}
            </button>
          );
        })}
      </div>

      <div className="px-4 pt-4 md:px-10">
      {/* Exactly one page mounted at a time. */}
      {selectedId !== null ? (
        <PlaylistDetailView playlistId={selectedId} onBack={handleBack} />
      ) : (
        <>
          {tab === 'songs' && <SongsSection />}
          {tab === 'favorites' && <FavoritesSection />}
          {tab === 'artists' && <ArtistsSection songs={downloads} loading={downloadsLoading} />}
          {tab === 'albums' && <AlbumsSection songs={downloads} loading={downloadsLoading} />}
          {tab === 'playlists' && <PlaylistsSection onOpen={setSelectedId} />}
          {tab === 'recent' && <RecentSection />}
        </>
      )}
      </div>
    </Container>
  );
}
