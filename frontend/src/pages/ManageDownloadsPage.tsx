/**
 * Settings → Storage → "Manage downloaded songs": pick the offline copies
 * to remove from this device.
 *
 * A route of its own rather than an inline list — rows toggle their own
 * selection, Select all / Deselect all flip the lot, and the delete runs
 * through `purgeDownloads`, which reports the whole batch with one
 * snackbar instead of one per song.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ArrowBackIcon, CheckIcon, TrashIcon } from '../components/icons';
import {
  Button,
  Container,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Shimmer,
} from '../components/ui';
import { listDownloads } from '../db/repos/downloads';
import type { DownloadedSong } from '../types/models';
import { cn } from '../utils/cn';
import { notify } from '../utils/downloadsStore';
import { formatBytes } from '../utils/format';

export default function ManageDownloadsPage() {
  const navigate = useNavigate();
  /** `null` while the catalogue is still loading. */
  const [songs, setSongs] = useState<DownloadedSong[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      setSongs(await listDownloads({ sort: 'title', dir: 'asc' }));
    } catch {
      setSongs([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (videoId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(videoId)) next.delete(videoId);
      else next.add(videoId);
      return next;
    });

  const removeSelected = async () => {
    const ids = [...selected];
    if (!ids.length || deleting) return;
    setDeleting(true);
    try {
      // the download pipeline is heavy — keep it out of the first bundle
      const { purgeDownloads } = await import('../utils/downloads');
      await purgeDownloads(ids);
      setSelected(new Set());
      await load();
    } catch {
      notify('error', 'Could not remove the selected songs');
    } finally {
      setDeleting(false);
    }
  };

  const allIds = songs?.map((song) => song.videoId) ?? [];
  const allSelected = allIds.length > 0 && selected.size >= allIds.length;
  const totalBytes = songs?.reduce((sum, song) => sum + (song.bytes || 0), 0) ?? 0;

  return (
    <Container maxWidth="sm" className="pb-8 pt-4 md:pt-6">
      <div className="flex flex-col gap-4">
        <div>
          <div className="flex flex-row items-center gap-1">
            <IconButton edge="start" aria-label="Back to settings" onClick={() => navigate('/settings')}>
              <ArrowBackIcon />
            </IconButton>
            <h5 className="m-0 text-2xl font-bold">Downloads</h5>
          </div>
          <p className="m-0 mt-1 ps-1 text-sm leading-[1.43] text-muted">
            Choose the songs to delete from this device. Streams parked in the cache are cleared
            separately, from Settings → Storage.
          </p>
        </div>

        <div className="flex flex-row items-center justify-between gap-2">
          <span className="text-sm tabular-nums text-muted">
            {songs === null
              ? '…'
              : `${songs.length} song${songs.length === 1 ? '' : 's'} · ${formatBytes(totalBytes)}`}
          </span>
          <div className="flex flex-row gap-1">
            <Button
              className="!px-3 !py-1 !text-xs"
              disabled={!allIds.length || allSelected}
              onClick={() => setSelected(new Set(allIds))}
            >
              Select all
            </Button>
            <Button
              className="!px-3 !py-1 !text-xs"
              disabled={!selected.size}
              onClick={() => setSelected(new Set())}
            >
              Deselect all
            </Button>
          </div>
        </div>

        {songs === null ? (
          <div className="flex flex-col gap-3">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex flex-row items-center gap-4">
                <Shimmer variant="rounded" width={46} height={46} />
                <div className="flex-1">
                  <Shimmer variant="text" width="60%" className="mb-[5px]" />
                  <Shimmer variant="text" width="35%" />
                </div>
              </div>
            ))}
          </div>
        ) : songs.length === 0 ? (
          <div className="rounded-card border border-line bg-surface px-4 py-8 text-center">
            <p className="m-0 text-sm text-muted">Nothing has been downloaded yet.</p>
          </div>
        ) : (
          <List className="rounded-[12px] border border-line bg-surface !py-1">
            {songs.map((song) => {
              const checked = selected.has(song.videoId);
              return (
                <ListItemButton
                  key={song.videoId}
                  aria-pressed={checked}
                  onClick={() => toggle(song.videoId)}
                  className="mx-1 !rounded-[12px]"
                >
                  <span
                    aria-hidden
                    className={cn(
                      'mr-3 grid h-5 w-5 shrink-0 place-items-center rounded-[6px] border-2 transition-colors',
                      checked ? 'border-accent bg-accent text-accent-contrast' : 'border-disabled',
                    )}
                  >
                    {checked && <CheckIcon sx={{ fontSize: 14 }} />}
                  </span>
                  <ListItemText
                    primary={song.title}
                    secondary={`${song.artist || 'Unknown artist'} · ${formatBytes(song.bytes)}`}
                  />
                </ListItemButton>
              );
            })}
          </List>
        )}

        <Button
          variant="contained"
          color="error"
          fullWidth
          startIcon={<TrashIcon />}
          disabled={!selected.size || deleting}
          onClick={() => void removeSelected()}
        >
          {deleting
            ? 'Deleting…'
            : `Delete selected${selected.size ? ` (${selected.size})` : ''}`}
        </Button>
      </div>
    </Container>
  );
}
