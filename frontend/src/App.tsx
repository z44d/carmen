import { useEffect, useRef } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

import Layout from './components/Layout';
import ArtistPage from './pages/ArtistPage';
import CollectionPage from './pages/CollectionPage';
import HomePage from './pages/HomePage';
import IntroPage from './pages/intro/IntroPage';
import LibraryPage from './pages/LibraryPage';
import ManageDownloadsPage from './pages/ManageDownloadsPage';
import QueuePage from './pages/QueuePage';
import SearchPage from './pages/SearchPage';
import SettingsPage from './pages/SettingsPage';
import SongPage from './pages/SongPage';
import UpdateDialog from './components/UpdateDialog';
import { loadAppState, saveAppState, type NavigationState, NAVIGATION_KEY } from './db/repos/appState';
import { PlayerProvider } from './player/PlayerContext';
import { ThemeProvider } from './theme/ThemeContext';

/**
 * Persists the active route (path + query) on every navigation.
 *
 * This is what makes "close → reopen from the tray / launcher" land on the
 * exact same page: the write is debounced, and the last navigation before a
 * close is always flushed by the time the window is gone (see DEVEL
 * — the window is hidden, not destroyed, and a full relaunch reads the row).
 */
function RoutePersistence() {
  const location = useLocation();

  useEffect(() => {
    const timer = setTimeout(() => {
      void saveAppState(NAVIGATION_KEY, {
        pathname: location.pathname,
        search: location.search,
      } satisfies NavigationState).catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [location.pathname, location.search]);

  return null;
}

/**
 * Redirects to the saved route when the window was opened without one.
 *
 * `main.tsx` seeds `window.location.hash` before rendering; this component
 * covers the case where the seeded value points at a route that vanished.
 *
 * The restore runs **exactly once per app launch**. React Router's `navigate`
 * gets a new identity on every location change, so keying the effect on it
 * (as an earlier version did) re-ran the restore after every navigation —
 * clicking "Home" from Library then raced the 250ms route-save debounce,
 * read the stale saved route and bounced straight back to Library.
 */
function RouteGuard() {
  const navigate = useNavigate();
  const restoredRef = useRef(false);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    void loadAppState<NavigationState>(NAVIGATION_KEY, { pathname: '/', search: '' })
      .then((saved) => {
        if (!saved?.pathname) return;
        if (window.location.hash === '#/' || window.location.hash === '#') {
          navigate(`${saved.pathname}${saved.search ?? ''}`, { replace: true });
        }
      })
      .catch(() => {});
  }, [navigate]);

  return null;
}

export default function App() {
  return (
    <ThemeProvider>
      <PlayerProvider>
        <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <RoutePersistence />
          <RouteGuard />
          {/* Tauri-only: asks to update when GitHub's latest tag is newer
              than this build (no-op in the browser). */}
          <UpdateDialog />
          <Routes>
            {/* Landing page — deliberately outside <Layout/>: no player
                shell, no app navigation, its own scroller. Shared as the
                "get Carmen" link (`#/intro`). */}
            <Route path="intro" element={<IntroPage />} />
            <Route element={<Layout />}>
              <Route index element={<HomePage />} />
              <Route path="search" element={<SearchPage />} />
              <Route path="queue" element={<QueuePage />} />
              <Route path="library" element={<LibraryPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="settings/downloads" element={<ManageDownloadsPage />} />
              <Route path="collection/:kind/:id" element={<CollectionPage />} />
              {/* artist cards open here; `#/song/:videoId` is the target a
                  shared link folds into (see main.tsx) */}
              <Route path="artist/:channelId" element={<ArtistPage />} />
              <Route path="song/:videoId" element={<SongPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </HashRouter>
      </PlayerProvider>
    </ThemeProvider>
  );
}
