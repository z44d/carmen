/**
 * Playlists page — the Library's Playlists tab: a responsive grid of
 * playlist cards plus the create / rename / delete flows. Opening a card
 * swaps the whole Library content area for the detail view (see
 * `LibraryPage`), so coming back remounts this page and its data is fresh
 * again by construction. The tab bar owns the title; the "New playlist"
 * action sits on the summary line.
 */
import { useCallback, useEffect, useState } from 'react';

import MarqueeText from '../../components/MarqueeText';
import { Button, IconButton, Shimmer, Tooltip } from '../../components/ui';
import { Menu, MenuItem } from '../../components/ui/Overlay';
import {
  createPlaylist,
  deletePlaylist,
  listPlaylistTracks,
  listPlaylists,
  renamePlaylist,
} from '../../db/repos/playlists';
import type { Playlist } from '../../types/models';
import { cdnArtwork } from '../../utils/track';
import { ConfirmDialog, EmptyHint, PageSummary, PlaylistFormDialog } from './common';
import SpotifyImportDialog, { SpotifyMark } from './SpotifyImportDialog';
import { Artwork, EditIcon, MoreVertIcon, MusicNoteIcon, PlusIcon, TrashIcon } from './glyphs';

interface PlaylistsSectionProps {
  /** Called with the playlist id — the parent opens the detail view. */
  onOpen: (playlistId: number) => void;
}

interface FormTarget {
  mode: 'create' | 'rename';
  playlist: Playlist | null;
}

export default function PlaylistsSection({ onOpen }: PlaylistsSectionProps) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [covers, setCovers] = useState<Record<number, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; playlist: Playlist } | null>(null);
  const [form, setForm] = useState<FormTarget | null>(null);
  const [deleteFor, setDeleteFor] = useState<Playlist | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [spotifyOpen, setSpotifyOpen] = useState(false);

  /** Playlist list + cover artwork (explicit cover video → first track). */
  const load = useCallback(async () => {
    const lists = await listPlaylists();
    setPlaylists(lists);

    const entries: [number, string | null][] = await Promise.all(
      lists.map(async (playlist): Promise<[number, string | null]> => {
        if (playlist.coverVideoId) {
          return [playlist.id, cdnArtwork(playlist.coverVideoId)];
        }
        try {
          const songs = await listPlaylistTracks(playlist.id);
          return [playlist.id, songs[0]?.artwork ?? null];
        } catch {
          return [playlist.id, null];
        }
      }),
    );
    const map: Record<number, string | null> = {};
    for (const [id, artwork] of entries) map[id] = artwork;
    setCovers(map);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .catch((loadError) => console.warn('[library] load playlists failed', loadError))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const handleCreate = async (name: string, description: string) => {
    await createPlaylist(name, description);
    await load();
  };

  const handleRename = async (name: string) => {
    if (!form?.playlist) return;
    await renamePlaylist(form.playlist.id, name);
    await load();
  };

  const handleDelete = async () => {
    if (!deleteFor || deleting) return;
    setDeleting(true);
    try {
      await deletePlaylist(deleteFor.id);
      setDeleteFor(null);
      await load();
    } finally {
      setDeleting(false);
    }
  };

  const empty = !loading && playlists.length === 0;

  return (
    <section>
      <PageSummary
        action={
          <>
            <Button
              variant="contained"
              aria-label="Import from Spotify"
              startIcon={<SpotifyMark size={18} />}
              onClick={() => setSpotifyOpen(true)}
              className="!bg-[#1DB954] !text-black hover:!bg-[#1ed760]"
            >
              {/* Short label on narrow phones so both actions fit. */}
              <span aria-hidden className="hidden min-[420px]:inline">Import from Spotify</span>
              <span aria-hidden className="min-[420px]:hidden">Import</span>
            </Button>
            {/* MIGRATION: the kit Button has no `outlined` variant — the text
            variant plus a border class is the closest match. */}
            <Button
              variant="text"
              className="border border-accent/50"
              startIcon={<PlusIcon />}
              onClick={() => setForm({ mode: 'create', playlist: null })}
            >
              New playlist
            </Button>
          </>
        }
      >
        {loading
          ? 'Loading…'
          : `${playlists.length} playlist${playlists.length === 1 ? '' : 's'}`}
      </PageSummary>

      {loading && playlists.length === 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
          {[0, 1, 2, 3].map((index) => (
            <Shimmer key={index} variant="rounded" height={196} />
          ))}
        </div>
      ) : empty ? (
        <EmptyHint
          title="No playlists yet"
          hint="Create one to group songs from your downloads, favorites or the web."
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4">
          {playlists.map((playlist) => (
            <div key={playlist.id} className="relative">
              <button
                type="button"
                onClick={() => onOpen(playlist.id)}
                className={
                  // No automatic minimum: a long playlist name clips +
                  // scrolls inside the cell instead of inflating the card.
                  // The stretch must be explicit: WebKit's UA sheet pins
                  // align-items: flex-start on <button> (older macOS
                  // WKWebView would size the text cell to the whole name).
                  'm-0 flex w-full min-w-0 cursor-pointer flex-col items-stretch gap-2 border-0 bg-transparent p-0 text-left hover:[&_.playlist-art]:[transform:scale(1.03)]'
                }
              >
                <Artwork
                  className="playlist-art"
                  src={covers[playlist.id] ?? null}
                  alt=""
                  icon={MusicNoteIcon}
                  iconSize={44}
                  style={{
                    width: '100%',
                    aspectRatio: '1 / 1',
                    borderRadius: 28,
                    boxShadow: 'var(--shadow-elev-1)',
                    transition: 'transform 220ms ease',
                  }}
                />
                <div className="w-full min-w-0">
                  <MarqueeText text={playlist.name} variant="body2" sx={{ fontWeight: 600 }} />
                  <span className="block text-xs leading-[1.4] text-muted">
                    {playlist.trackCount} song{playlist.trackCount === 1 ? '' : 's'}
                  </span>
                </div>
              </button>

              {/* The kit Tooltip wraps its child in a `relative` span, so the
                  absolute anchoring moves onto an outer span (MUI's Tooltip
                  added no DOM node, and the button overlays the card corner). */}
              <span className="absolute right-[6px] top-[6px]">
                <Tooltip title="Playlist actions" placement="top">
                  <IconButton
                    size="small"
                    aria-label={`Actions for ${playlist.name}`}
                    onClick={(event) => setMenu({ anchor: event.currentTarget, playlist })}
                    className="h-[30px] w-[30px] bg-[rgba(0,0,0,0.45)] !p-0 !text-white hover:!bg-[rgba(0,0,0,0.65)]"
                  >
                    <MoreVertIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </Tooltip>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* MIGRATION: `anchorOrigin` / `transformOrigin` dropped — the kit Menu
          positions itself from the anchor and flips when it would overflow. */}
      <Menu
        anchorEl={menu?.anchor ?? null}
        open={Boolean(menu)}
        onClose={() => setMenu(null)}
      >
        <MenuItem
          onClick={() => {
            if (menu) setForm({ mode: 'rename', playlist: menu.playlist });
            setMenu(null);
          }}
        >
          <EditIcon fontSize="small" />
          Rename
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menu) setDeleteFor(menu.playlist);
            setMenu(null);
          }}
        >
          <TrashIcon fontSize="small" />
          Delete
        </MenuItem>
      </Menu>

      <PlaylistFormDialog
        open={Boolean(form)}
        mode={form?.mode ?? 'create'}
        initialName={form?.playlist?.name ?? ''}
        initialDescription={form?.playlist?.description ?? ''}
        onSubmit={form?.mode === 'rename' ? handleRename : handleCreate}
        onClose={() => setForm(null)}
      />

      <ConfirmDialog
        open={deleteFor !== null}
        title="Delete playlist?"
        message={`“${deleteFor?.name ?? ''}” will be removed. The songs themselves stay in your library.`}
        busy={deleting}
        onConfirm={() => void handleDelete()}
        onClose={() => setDeleteFor(null)}
      />

      <SpotifyImportDialog
        open={spotifyOpen}
        onClose={() => setSpotifyOpen(false)}
        onOpenPlaylist={onOpen}
      />
    </section>
  );
}
