/**
 * Spotify → YouTube Music import dialog.
 *
 * A four-act flow that never leaves this dialog:
 *
 *   1. **input** — paste a Spotify playlist link (validated locally);
 *   2. **preview** — the playlist's cover, owner and track list, straight
 *      from Spotify, so the user knows exactly what is about to convert;
 *   3. **converting** — the backend streams one server-sent event per
 *      track; the progress bar, percentage and live counters render those
 *      real numbers — nothing is faked;
 *   4. **results** — every track with its match status, confidence and the
 *      YouTube Music song it resolved to; the user picks the winners and
 *      saves them as a normal library playlist (playable, downloadable,
 *      offline-capable like any other).
 *
 * The dialog is a centred sheet on desktop and stretches to nearly the
 * full viewport on a phone; every row wraps instead of overflowing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';

import { Button, Chip, IconButton, Spinner } from '../../components/ui';
import { Dialog, DialogActions, DialogContent, DialogTitle } from '../../components/ui/Overlay';
import { TextField } from '../../components/ui/Field';
import MarqueeText from '../../components/MarqueeText';
import { cn } from '../../utils/cn';
import {
  convertSpotifyPlaylist,
  friendlyConvertError,
  parseSpotifyPlaylistUrl,
  resolveSpotifyPlaylist,
  saveConversionAsPlaylist,
  type ConvertProgress,
  type SpotifyPlaylistInfo,
  type TrackConversion,
} from '../../services/spotifyConvert';
import { Artwork, CheckCircleIcon, CloseIcon } from './glyphs';

export const SPOTIFY_GREEN = '#1DB954';

type Step = 'input' | 'preview' | 'converting' | 'results' | 'saved';

interface SpotifyImportDialogProps {
  open: boolean;
  onClose: () => void;
  /** Jump to the newly created playlist (the parent owns the detail view). */
  onOpenPlaylist: (playlistId: number) => void;
}

/* ── Spotify mark ─────────────────────────────────────────────────────── */

/** The Spotify-ish mark used by the import entry points (also the section). */
export function SpotifyMark({ size = 22, sx }: { size?: number; sx?: { fontSize?: number } }) {
  const rendered = sx?.fontSize ?? size;
  return (
    <svg width={rendered} height={rendered} viewBox="0 0 24 24" aria-hidden focusable="false">
      <circle cx="12" cy="12" r="12" fill={SPOTIFY_GREEN} />
      <g fill="none" stroke="#0b0b0b" strokeLinecap="round">
        <path d="M7.2 10.4c3.1-1 7.9-.9 10.9 1" strokeWidth="1.7" />
        <path d="M7.9 13.1c2.6-.8 6.4-.7 8.9.9" strokeWidth="1.5" />
        <path d="M8.6 15.6c2.1-.6 5-.5 6.9.7" strokeWidth="1.3" />
      </g>
    </svg>
  );
}

/* ── match status furniture ───────────────────────────────────────────── */

const STATUS_META = {
  matched: { label: 'Matched', color: '#1DB954', bg: 'rgba(29,185,84,0.14)' },
  approximate: { label: 'Close match', color: '#e8a13c', bg: 'rgba(232,161,60,0.14)' },
  not_found: { label: 'No match', color: '#9aa0a6', bg: 'rgba(154,160,166,0.14)' },
  error: { label: 'Failed', color: '#e5484d', bg: 'rgba(229,72,77,0.14)' },
} as const;

function StatusPill({ status, confidence }: { status: keyof typeof STATUS_META; confidence: number }) {
  const meta = STATUS_META[status];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold leading-5"
      style={{ color: meta.color, background: meta.bg }}
    >
      {status === 'matched' && <CheckCircleIcon style={{ fontSize: 13 }} />}
      {status === 'not_found' && <CloseIcon style={{ fontSize: 13 }} />}
      {meta.label}
      {(status === 'matched' || status === 'approximate') && (
        <span className="opacity-80">{Math.round(confidence * 100)}%</span>
      )}
    </span>
  );
}

/* ── accessible checkbox (the kit has no Checkbox) ────────────────────── */

function RowCheckbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={cn(
        'flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-[8px] border-2 transition-colors',
        checked ? 'border-transparent' : 'border-line bg-transparent hover:border-muted',
      )}
      style={checked ? { background: SPOTIFY_GREEN } : undefined}
    >
      {checked && (
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
          <path
            d="M2.5 7.2 5.6 10.3 11.5 3.9"
            fill="none"
            stroke="#0b0b0b"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}

/* ── determinate progress bar ─────────────────────────────────────────── */

function Meter({ value }: { value: number }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      className="h-2 w-full overflow-hidden rounded-full bg-hover"
    >
      <div
        className="h-full rounded-full transition-[width] duration-300 ease-out"
        style={{ width: `${Math.min(100, Math.max(0, value))}%`, background: SPOTIFY_GREEN }}
      />
    </div>
  );
}

/* ══ the dialog ══════════════════════════════════════════════════════════ */

export default function SpotifyImportDialog({ open, onClose, onOpenPlaylist }: SpotifyImportDialogProps) {
  const [step, setStep] = useState<Step>('input');
  const [link, setLink] = useState('');
  const [linkTouched, setLinkTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playlist, setPlaylist] = useState<SpotifyPlaylistInfo | null>(null);
  const [progress, setProgress] = useState<ConvertProgress | null>(null);
  const [live, setLive] = useState<TrackConversion[]>([]);
  const [results, setResults] = useState<TrackConversion[]>([]);
  const [summary, setSummary] = useState({ total: 0, matched: 0, approximate: 0, not_found: 0, error: 0 });
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<number | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const linkValid = useMemo(() => parseSpotifyPlaylistUrl(link) !== null, [link]);
  const showLinkError = linkTouched && link.trim() !== '' && !linkValid;

  // Fresh state every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setStep('input');
    setLink('');
    setLinkTouched(false);
    setBusy(false);
    setError(null);
    setPlaylist(null);
    setProgress(null);
    setLive([]);
    setResults([]);
    setSummary({ total: 0, matched: 0, approximate: 0, not_found: 0, error: 0 });
    setName('');
    setSelected(new Set());
    setSaving(false);
    setSavedId(null);
    setSavedCount(0);
    abortRef.current?.abort();
    abortRef.current = null;
  }, [open ]);

  // Abandon in-flight work when the dialog closes mid-flight.
  useEffect(() => {
    if (!open) abortRef.current?.abort();
  }, [open ]);

  const close = useCallback(() => {
    if (busy || saving) return;
    abortRef.current?.abort();
    onClose();
  }, [busy, saving, onClose]);

  /* ── act 1 → 2: resolve the Spotify link ── */

  const fetchPreview = useCallback(async () => {
    const trimmed = link.trim();
    setLinkTouched(true);
    if (!parseSpotifyPlaylistUrl(trimmed) || busy) return;
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const info = await resolveSpotifyPlaylist(trimmed, controller.signal);
      setPlaylist(info);
      setName(info.name);
      setStep('preview');
    } catch (fetchError) {
      if ((fetchError as Error)?.name === 'AbortError') return;
      const apiError = fetchError as { status?: number; message?: string };
      setError(friendlyConvertError(apiError?.status ?? 0, apiError?.message ?? ''));
    } finally {
      setBusy(false);
    }
  }, [link, busy]);

  /* ── act 2 → 3: convert, streaming real progress ── */

  const startConversion = useCallback(async () => {
    if (!playlist || busy) return;
    setBusy(true);
    setError(null);
    setLive([]);
    setProgress(null);
    setResults([]);
    setStep('converting');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const outcome = await convertSpotifyPlaylist(
        link.trim(),
        (event) => {
          setProgress(event);
          setLive((previous) => [...previous, event.result]);
        },
        controller.signal,
        Math.min(200, Math.max(playlist.track_count, 1)),
      );
      setResults(outcome.results);
      setSummary(outcome.summary);
      setSelected(
        new Set(
          outcome.results
            .filter((result) => result.match && result.status !== 'not_found')
            .map((result) => result.spotify.id),
        ),
      );
      setStep('results');
    } catch (convertError) {
      if ((convertError as Error)?.name === 'AbortError') {
        setStep('preview');
        return;
      }
      const apiError = convertError as { status?: number; message?: string };
      setError(friendlyConvertError(apiError?.status ?? 0, apiError?.message ?? ''));
      setStep('preview');
    } finally {
      setBusy(false);
    }
  }, [playlist, link, busy]);

  const cancelConversion = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /* ── act 4: save the picks as a library playlist ── */

  const toggleSelected = useCallback((id: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectable = useMemo(
    () => results.filter((result) => result.match && result.status !== 'not_found'),
    [results],
  );
  const allSelected = selectable.length > 0 && selectable.every((result) => selected.has(result.spotify.id));

  const toggleAll = useCallback(() => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(selectable.map((result) => result.spotify.id)));
  }, [allSelected, selectable]);

  const save = useCallback(async () => {
    if (saving || selected.size === 0) return;
    setSaving(true);
    setError(null);
    try {
      const picks = results.filter((result) => selected.has(result.spotify.id));
      const id = await saveConversionAsPlaylist(results, {
        name: name.trim() || playlist?.name || 'Imported from Spotify',
        selected: picks,
        description: playlist
          ? `Imported from Spotify · “${playlist.name}”${playlist.owner ? ` by ${playlist.owner}` : ''}`
          : 'Imported from Spotify',
      });
      setSavedId(id);
      setSavedCount(picks.filter((pick) => pick.match).length);
      setStep('saved');
    } catch {
      setError('Could not save the playlist — please try again.');
    } finally {
      setSaving(false);
    }
  }, [saving, selected, results, name, playlist]);

  const progressPercent = progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0;

  return (
    <Dialog open={open} onClose={close} maxWidth="md" className="!rounded-[28px]">
      <DialogTitle className="!pb-1">
        <div className="flex items-center gap-3 pr-10">
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl"
            style={{ background: 'rgba(29,185,84,0.14)' }}
          >
            <SpotifyMark size={26} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-lg font-bold leading-7">Import from Spotify</span>
            <span className="block truncate text-xs font-normal leading-5 text-muted">
              Spotify playlist → YouTube Music matches → your library
            </span>
          </span>
        </div>
        <IconButton
          aria-label="Close"
          onClick={close}
          disabled={busy || saving}
          className="!absolute right-2 top-2"
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <DialogContent className="!px-4 sm:!px-6">
        {error && (
          <div
            role="alert"
            className="mb-4 flex items-start gap-3 rounded-2xl border border-[rgba(229,72,77,0.35)] bg-[rgba(229,72,77,0.08)] px-4 py-3"
          >
            <CloseIcon style={{ fontSize: 18, color: '#e5484d', marginTop: 2 }} />
            <p className="m-0 min-w-0 flex-1 text-sm leading-6 text-body">{error}</p>
          </div>
        )}

        {step === 'input' && (
          <motion.div
            key="input"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            className="pb-2"
          >
            <div
              className="mb-5 overflow-hidden rounded-3xl border border-line px-5 py-6 text-center sm:px-8 sm:py-8"
              style={{
                background:
                  'radial-gradient(120% 140% at 50% 0%, rgba(29,185,84,0.16) 0%, rgba(29,185,84,0.03) 55%, transparent 100%)',
              }}
            >
              <div className="mb-3 flex justify-center">
                <span
                  className="flex h-16 w-16 items-center justify-center rounded-full"
                  style={{ background: 'rgba(29,185,84,0.16)', boxShadow: '0 0 44px rgba(29,185,84,0.35)' }}
                >
                  <SpotifyMark size={34} />
                </span>
              </div>
              <p className="m-0 text-xl font-bold leading-8 sm:text-2xl sm:leading-9">
                Bring your Spotify playlists home
              </p>
              <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted">
                Paste a playlist link — we read every song from Spotify and find
                its twin on YouTube Music, ready to play in Carmen.
              </p>
            </div>

            <TextField
              autoFocus
              fullWidth
              label="Spotify playlist link"
              placeholder="https://open.spotify.com/playlist/…"
              value={link}
              onChange={(event) => {
                setLink(event.target.value);
                setLinkTouched(true);
              }}
              disabled={busy}
              error={showLinkError}
              helperText={
                showLinkError
                  ? 'That doesn\u2019t look like a Spotify playlist link.'
                  : 'Open the playlist in Spotify → Share → Copy link. Public playlists only.'
              }
              inputProps={{
                inputMode: 'url',
                autoCapitalize: 'off',
                autoCorrect: 'off',
                spellCheck: false,
                'aria-label': 'Spotify playlist link',
                onKeyDown: (event: React.KeyboardEvent) => {
                  if (event.key === 'Enter') void fetchPreview();
                },
              }}
            />

            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {[
                ['1', 'Paste the link', 'Any public Spotify playlist'],
                ['2', 'Preview it', 'Cover, songs and track count'],
                ['3', 'Convert & save', 'Matched songs land in your library'],
              ].map(([number, title, hint]) => (
                <div key={number} className="rounded-2xl border border-line bg-surface px-3 py-2.5">
                  <p className="m-0 flex items-center gap-2 text-sm font-semibold">
                    <span
                      className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold"
                      style={{ background: 'rgba(29,185,84,0.16)', color: SPOTIFY_GREEN }}
                    >
                      {number}
                    </span>
                    {title}
                  </p>
                  <p className="m-0 mt-0.5 pl-8 text-xs leading-5 text-muted">{hint}</p>
                </div>
              ))}
            </div>
          </motion.div>
        )}

        {step === 'preview' && playlist && (
          <motion.div key="preview" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
            <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center">
              <Artwork
                src={playlist.artwork}
                alt=""
                icon={SpotifyMark as never}
                iconSize={40}
                className="shrink-0"
                style={{
                  width: '100%',
                  maxWidth: 168,
                  aspectRatio: '1 / 1',
                  borderRadius: 24,
                  boxShadow: 'var(--shadow-elev-1)',
                }}
              />
              <div className="min-w-0 flex-1">
                <p className="m-0 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-muted">
                  Spotify playlist
                </p>
                <h3 className="m-0 mt-0.5 break-words text-xl font-bold leading-8">{playlist.name}</h3>
                <p className="m-0 mt-1 text-sm leading-6 text-muted">
                  {playlist.owner && <span>by {playlist.owner} · </span>}
                  {playlist.track_count} song{playlist.track_count === 1 ? '' : 's'}
                </p>
                {playlist.description && (
                  <p className="m-0 mt-1 line-clamp-2 text-xs leading-5 text-disabled">
                    {playlist.description.replace(/<[^>]*>/g, '')}
                  </p>
                )}
              </div>
            </div>

            <p className="m-0 mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted">
              First songs
            </p>
            <ol className="m-0 mb-2 list-none p-0">
              {playlist.tracks.slice(0, 6).map((track, index) => (
                <li
                  key={track.id}
                  className="flex min-w-0 items-center gap-3 border-b border-line py-2 last:border-0"
                >
                  <span className="w-6 shrink-0 text-center text-xs font-semibold text-disabled">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <MarqueeText text={track.title} variant="body2" sx={{ fontWeight: 600 }} />
                    <span className="block truncate text-xs leading-5 text-muted">{track.artist}</span>
                  </span>
                </li>
              ))}
            </ol>
            {playlist.track_count > 6 && (
              <p className="m-0 mb-1 text-xs leading-5 text-disabled">
                …and {playlist.track_count - 6} more
              </p>
            )}
          </motion.div>
        )}

        {step === 'converting' && (
          <motion.div
            key="converting"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            className="py-4"
          >
            <div className="mb-5 text-center">
              <p className="m-0 text-5xl font-bold tabular-nums leading-none" style={{ color: SPOTIFY_GREEN }}>
                {Math.round(progressPercent)}
                <span className="text-2xl">%</span>
              </p>
              <p className="m-0 mt-2 text-sm leading-6 text-muted">
                {progress ? (
                  <>
                    Matching song {progress.done} of {progress.total} ·{' '}
                    {live.filter((r) => r.status === 'matched').length} matched ·{' '}
                    {live.filter((r) => r.status === 'approximate').length} close
                  </>
                ) : (
                  'Warming up…'
                )}
              </p>
            </div>
            <Meter value={progressPercent} />
            <div className="mt-5 min-h-[44px] rounded-2xl border border-line bg-surface px-4 py-2.5">
              {progress ? (
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <Spinner size={16} />
                  <span className="min-w-0 flex-1">
                    <MarqueeText
                      text={`${progress.result.spotify.title} — ${progress.result.spotify.artist}`}
                      variant="body2"
                    />
                  </span>
                </div>
              ) : (
                <p className="m-0 text-sm leading-6 text-muted">Reading the playlist…</p>
              )}
            </div>
            <p className="m-0 mt-4 text-center text-xs leading-5 text-disabled">
              Searching YouTube Music for each song — long playlists can take a minute.
            </p>
          </motion.div>
        )}

        {step === 'results' && (
          <motion.div key="results" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
            <div className="mb-4 grid grid-cols-3 gap-2">
              {(
                [
                  ['matched', summary.matched, 'Matched'],
                  ['approximate', summary.approximate, 'Close'],
                  ['not_found', summary.not_found + summary.error, 'No match'],
                ] as const
              ).map(([key, count, label]) => (
                <div
                  key={key}
                  className="rounded-2xl border border-line px-3 py-2.5 text-center"
                  style={{ background: STATUS_META[key].bg }}
                >
                  <p className="m-0 text-2xl font-bold tabular-nums leading-8" style={{ color: STATUS_META[key].color }}>
                    {count}
                  </p>
                  <p className="m-0 text-xs leading-5 text-muted">{label}</p>
                </div>
              ))}
            </div>

            <TextField
              fullWidth
              label="Playlist name in your library"
              value={name}
              onChange={(event) => setName(event.target.value)}
              margin="dense"
              inputProps={{ maxLength: 120 }}
            />

            <div className="mb-1 mt-2 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={toggleAll}
                className="flex cursor-pointer items-center gap-2 border-0 bg-transparent p-1 text-sm font-medium text-muted"
              >
                <RowCheckbox checked={allSelected} onChange={toggleAll} label="Select all matched songs" />
                {selected.size} of {selectable.length} selected
              </button>
              <span className="text-xs leading-5 text-disabled">Unmatched songs can’t be saved</span>
            </div>

            <ul className="m-0 list-none p-0">
              {results.map((result) => {
                const usable = Boolean(result.match) && result.status !== 'not_found';
                const checked = selected.has(result.spotify.id);
                const matchTitle =
                  result.match && typeof result.match.title === 'string' ? result.match.title : '';
                const matchArtist =
                  result.match && Array.isArray(result.match.artists)
                    ? result.match.artists
                        .map((artist: unknown) =>
                          typeof artist === 'string' ? artist : (artist as { name?: string })?.name,
                        )
                        .filter(Boolean)
                        .join(', ')
                    : '';
                return (
                  <li
                    key={result.spotify.id}
                    className={cn(
                      'flex min-w-0 items-start gap-3 border-b border-line py-2.5 last:border-0',
                      !usable && 'opacity-60',
                    )}
                  >
                    <span className="mt-0.5">
                      <RowCheckbox
                        checked={checked}
                        onChange={() => usable && toggleSelected(result.spotify.id)}
                        label={`Include ${result.spotify.title}`}
                      />
                    </span>
                    <button
                      type="button"
                      disabled={!usable}
                      onClick={() => toggleSelected(result.spotify.id)}
                      className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1 border-0 bg-transparent p-0 text-left disabled:cursor-default"
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="min-w-0 flex-1 basis-full sm:basis-auto">
                          <MarqueeText text={result.spotify.title} variant="body2" sx={{ fontWeight: 600 }} />
                          <span className="block truncate text-xs leading-5 text-muted">
                            {result.spotify.artist}
                            <span className="text-disabled"> · Spotify</span>
                          </span>
                        </span>
                        <StatusPill status={result.status} confidence={result.confidence} />
                      </span>
                      {result.match ? (
                        <span className="block min-w-0 truncate text-xs leading-5 text-muted">
                          <span style={{ color: SPOTIFY_GREEN }}>→ </span>
                          {matchTitle}
                          {matchArtist && <span> — {matchArtist}</span>}
                        </span>
                      ) : (
                        <span className="block text-xs leading-5 text-disabled">
                          {result.status === 'error'
                            ? `Search failed${result.error ? `: ${result.error}` : ''}`
                            : 'No close match on YouTube Music'}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        )}

        {step === 'saved' && (
          <motion.div
            key="saved"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.2 }}
            className="py-6 text-center"
          >
            <motion.span
              initial={{ scale: 0.6 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 320, damping: 18 }}
              className="mb-4 inline-flex h-20 w-20 items-center justify-center rounded-full"
              style={{ background: 'rgba(29,185,84,0.14)' }}
            >
              <CheckCircleIcon style={{ fontSize: 44, color: SPOTIFY_GREEN }} />
            </motion.span>
            <p className="m-0 text-xl font-bold leading-8">Playlist saved</p>
            <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-muted">
              <span className="font-semibold text-body">{name.trim() || playlist?.name}</span>
              {' '}is in your library with {savedCount} song{savedCount === 1 ? '' : 's'}.
            </p>
            <div className="mt-3 flex justify-center">
              <Chip
                size="small"
                variant="outlined"
                label={`${summary.matched + summary.approximate} converted · ${summary.not_found + summary.error} had no match`}
              />
            </div>
          </motion.div>
        )}
      </DialogContent>

      <DialogActions className="flex-wrap !justify-between gap-2">
        <div>
          {(step === 'preview' || step === 'results') && (
            <Button onClick={() => (step === 'preview' ? setStep('input') : setStep('preview'))} disabled={busy || saving}>
              Back
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {step === 'input' && (
            <Button
              variant="contained"
              onClick={() => void fetchPreview()}
              disabled={!linkValid || busy}
              startIcon={busy ? <Spinner size={18} /> : <SpotifyMark size={18} />}
              className="!bg-[#1DB954] !text-black hover:!bg-[#1ed760] disabled:!bg-hover disabled:!text-disabled"
            >
              {busy ? 'Fetching…' : 'Fetch playlist'}
            </Button>
          )}
          {step === 'preview' && (
            <Button
              variant="contained"
              onClick={() => void startConversion()}
              disabled={busy}
              startIcon={busy ? <Spinner size={18} /> : <SpotifyMark size={18} />}
              className="!bg-[#1DB954] !text-black hover:!bg-[#1ed760]"
            >
              Convert to YouTube Music
            </Button>
          )}
          {step === 'converting' && (
            <Button onClick={cancelConversion} color="error">
              Cancel
            </Button>
          )}
          {step === 'results' && (
            <Button
              variant="contained"
              onClick={() => void save()}
              disabled={selected.size === 0 || saving}
              startIcon={saving ? <Spinner size={18} /> : undefined}
              className="!bg-[#1DB954] !text-black hover:!bg-[#1ed760] disabled:!bg-hover disabled:!text-disabled"
            >
              {saving ? 'Saving…' : `Save to library (${selected.size})`}
            </Button>
          )}
          {step === 'saved' && (
            <>
              <Button onClick={close}>Done</Button>
              <Button
                variant="contained"
                onClick={() => savedId !== null && onOpenPlaylist(savedId)}
                className="!bg-[#1DB954] !text-black hover:!bg-[#1ed760]"
              >
                Open playlist
              </Button>
            </>
          )}
        </div>
      </DialogActions>
    </Dialog>
  );
}
