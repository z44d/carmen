import { useCallback, useEffect, useState } from 'react';

import { fetchClientProviderResults, type ClientProviderEntry } from '../lyrics/chain';
import { useSettings } from '../settings/store';
import { lyricsChainLabel, type ProviderLyricsResult } from '../types/models';
import { cn } from '../utils/cn';
import { CloseIcon, ExpandLessIcon, ExpandMoreIcon, RefreshIcon } from './icons';
import { Dialog, DialogContent, DialogTitle } from './ui';

/**
 * Provider picker — Android's `LyricsSearchResultDialog`, ported.
 *
 * Lists every enabled chain provider's lyrics for the playing song.
 * Every result comes from the client-side chain in the browser
 * (direct fetch, then a public CORS relay for origins that send no
 * `Access-Control-Allow-Origin` header — Paxsenix stays direct-only).
 * There is no server call anywhere in this dialog: it works with the
 * API server unreachable. Provider name, sync badge (Word synced /
 * Synced / Plain), line + character counts, and a preview that
 * expands from 2 lines to 8. Tapping a card pins that provider for
 * this song only — the global chain order in Settings is never
 * touched. A "Best match" row appears while a provider is pinned,
 * returning to the chain's best result.
 */

interface LyricsProviderPickerProps {
  open: boolean;
  onClose: () => void;
  videoId: string;
  title?: string;
  artist?: string;
  album?: string;
  durationSeconds?: number;
  /** Provider id behind the lyrics currently on screen, if known. */
  currentProviderId: string | null;
  /** Pinned provider id, if the picker is choosing a replacement. */
  pinnedProviderId: string | null;
  /** `null` = clear the pin and return to the best match. */
  onSelect: (providerId: string | null) => void;
}

type LoadState = 'loading' | 'error' | 'done';

function syncBadge(
  result: ProviderLyricsResult & { emptyReason?: string | null; directFailed?: boolean; failedReason?: string | null },
  hasPaxsenixKey: boolean,
): string {
  if (result.synced?.length) {
    return result.synced.some((line) => line.words?.length)
      ? 'Word synced'
      : 'Synced';
  }
  if (result.unsynced?.trim()) return 'Plain';
  if (!result.available) {
    // Per-row reason, not a bare "Unavailable": Paxsenix is gated on
    // a key (Android behaviour).
    if (result.provider.startsWith('paxsenix-') && !hasPaxsenixKey) {
      return 'Needs API key — set it in Settings > Lyrics';
    }
    return 'Unavailable';
  }
  // Transport / upstream failure (direct fetch AND every relay
  // failed, or the upstream gated the query) is NOT "no lyrics
  // found": the provider never got to answer. Only a provider that
  // answered with nothing gets the empty label. A provider-known
  // gate (SimpMusic) names itself; an unresolved YouTube shell
  // page is a failure too, never "Not available on web".
  if (result.directFailed && result.failedReason) return result.failedReason;
  if (result.directFailed) return "Couldn't reach provider — try again";
  if (result.provider === 'youtube-subtitle' && result.emptyReason === 'unresolved') {
    return "Couldn't reach provider — try again";
  }
  if (result.provider === 'youtube-subtitle' && result.emptyReason === 'no-captions') {
    return 'No captions for this video';
  }
  if (result.provider === 'youtube-subtitle' && result.emptyReason === 'gated') {
    return 'Not available on web';
  }
  return 'No lyrics found';
}

function resultStats(result: ProviderLyricsResult): string | null {
  if (result.synced?.length) {
    const chars = result.synced.reduce((sum, line) => sum + line.text.length, 0);
    return `${result.synced.length} lines · ${chars} characters`;
  }
  if (result.unsynced?.trim()) return `${result.unsynced.trim().length} characters`;
  return null;
}

function previewLines(result: ProviderLyricsResult, expanded: boolean): string[] {
  const limit = expanded ? 8 : 2;
  if (result.synced?.length) {
    return result.synced
      .map((line) => line.text.trim())
      .filter(Boolean)
      .slice(0, limit);
  }
  if (result.unsynced?.trim()) {
    return result.unsynced.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, limit);
  }
  return [];
}

export default function LyricsProviderPicker({
  open,
  onClose,
  videoId,
  title,
  artist,
  album,
  durationSeconds,
  currentProviderId,
  pinnedProviderId,
  onSelect,
}: LyricsProviderPickerProps) {
  const { lyricsProviderOrder, lyricsProvidersEnabled, paxsenixApiKey } = useSettings();
  const [state, setState] = useState<LoadState>('loading');
  const [results, setResults] = useState<ClientProviderEntry[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setState('loading');
      const query = {
        videoId,
        title,
        artist,
        album,
        durationSeconds,
        order: lyricsProviderOrder,
        enabled: lyricsProvidersEnabled,
        ...(paxsenixApiKey ? { paxsenixKey: paxsenixApiKey } : {}),
      };
      // The client chain is the whole lyrics path: direct fetch,
      // then CORS relays. No server call — the picker works with
      // the API server unreachable or down.
      try {
        const entries = await fetchClientProviderResults(query, signal);
        if (signal.aborted) return;
        setResults(entries);
        setState('done');
      } catch (error) {
        if (signal.aborted || (error as Error)?.name === 'AbortError') return;
        setResults([]);
        setState('error');
      }
    },
    [videoId, title, artist, album, durationSeconds, lyricsProviderOrder, lyricsProvidersEnabled, paxsenixApiKey],
  );

  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [open, attempt, load]);

  const subtitle =
    state === 'loading'
      ? 'Searching providers…'
      : state === 'error'
        ? 'Could not reach the lyrics providers'
        : results.some((result) => result.synced?.length || result.unsynced?.trim())
          ? `${results.length} provider${results.length === 1 ? '' : 's'} checked`
          : 'No lyrics found';

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth aria-label="Choose lyrics provider">
      <DialogTitle>
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base font-bold leading-[1.3]">Search lyrics</span>
            <span className="block truncate text-xs font-normal leading-[1.4] text-muted">{subtitle}</span>
          </span>
          {state !== 'loading' && (
            <button
              type="button"
              aria-label="Search again"
              title="Search again"
              onClick={() => setAttempt((count) => count + 1)}
              className="grid size-10 shrink-0 place-items-center rounded-full text-body transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.94]"
            >
              <RefreshIcon />
            </button>
          )}
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid size-10 shrink-0 place-items-center rounded-full text-body transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.94]"
          >
            <CloseIcon />
          </button>
        </span>
      </DialogTitle>
      <DialogContent>
        <div className="flex flex-col gap-2 pb-1">
          {pinnedProviderId && (
            <button
              type="button"
              onClick={() => onSelect(null)}
              className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-[16px] border border-line bg-surface/60 px-4 py-3 text-left transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.99]"
            >
              <span className="min-w-0">
                <span className="block text-sm font-semibold leading-[1.43]">Best match</span>
                <span className="block text-xs leading-[1.4] text-muted">
                  Back to the chain&apos;s best result
                </span>
              </span>
              <span className="shrink-0 rounded-full bg-accent/15 px-2.5 py-1 text-xs font-semibold text-accent-fg">
                Pinned: {lyricsChainLabel(pinnedProviderId)}
              </span>
            </button>
          )}

          {state === 'loading' &&
            [0, 1, 2].map((index) => (
              <div
                key={index}
                aria-hidden
                className="h-[76px] animate-pulse rounded-[16px] border border-line bg-surface/60"
                style={{ opacity: 1 - index * 0.25 }}
              />
            ))}

          {state === 'error' && (
            <div className="grid place-items-center px-4 py-8 text-center">
              <p className="m-0 text-sm font-semibold text-body">Lyrics search failed</p>
              <span className="mt-1 block text-xs leading-[1.4] text-muted">
                Check the connection and try again.
              </span>
              <button
                type="button"
                onClick={() => setAttempt((count) => count + 1)}
                className="mt-4 cursor-pointer rounded-full border border-line bg-surface/60 px-4 py-1.5 text-sm font-semibold text-body transition hover:brightness-110 active:scale-[0.96]"
              >
                Retry
              </button>
            </div>
          )}

          {state === 'done' &&
            results.map((result, index) => {
              const hasLyrics = Boolean(result.synced?.length || result.unsynced?.trim());
              const selectable = result.available && hasLyrics;
              // Variants share a provider id (one provider can return
              // several lyric sets), so the row identity is id + index.
              const rowId = `${result.provider}-${index}`;
              const expanded = expandedId === rowId;
              const stats = resultStats(result);
              const preview = previewLines(result, expanded);
              const isCurrent = currentProviderId === result.provider;
              return (
                <div
                  key={rowId}
                  className={cn(
                    'rounded-[16px] border px-4 py-3 transition',
                    selectable
                      ? 'cursor-pointer border-line bg-surface/60 hover:brightness-110 active:scale-[0.99]'
                      : 'border-line/60 bg-surface/40 opacity-60',
                    isCurrent && 'border-accent/50',
                  )}
                  role={selectable ? 'button' : undefined}
                  tabIndex={selectable ? 0 : undefined}
                  aria-label={selectable ? `Use lyrics from ${result.name}` : undefined}
                  onClick={selectable ? () => onSelect(result.provider) : undefined}
                  onKeyDown={
                    selectable
                      ? (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            onSelect(result.provider);
                          }
                        }
                      : undefined
                  }
                >
                  <div className="flex items-center gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold leading-[1.43]">
                        {result.name || lyricsChainLabel(result.provider)}
                      </span>
                      <span className="block text-xs leading-[1.4] text-muted">{syncBadge(result, Boolean(paxsenixApiKey?.trim()))}</span>
                    </span>
                    {isCurrent && (
                      <span className="shrink-0 rounded-full bg-accent/15 px-2.5 py-1 text-xs font-semibold text-accent-fg">
                        Current
                      </span>
                    )}
                    {hasLyrics && (
                      <button
                        type="button"
                        aria-label={expanded ? 'Show less' : 'Show more'}
                        onClick={(event) => {
                          event.stopPropagation();
                          setExpandedId(expanded ? null : rowId);
                        }}
                        className="grid size-9 shrink-0 place-items-center rounded-full text-body transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.94]"
                      >
                        {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                      </button>
                    )}
                  </div>
                  {preview.length > 0 && (
                    <p className="m-0 mt-2 whitespace-pre-line text-sm leading-[1.5] text-muted">
                      {preview.join('\n')}
                    </p>
                  )}
                  {stats && (
                    <span className="mt-2 block text-xs leading-[1.4] text-disabled">{stats}</span>
                  )}
                </div>
              );
            })}

          {state === 'done' && results.length === 0 && (
            <p className="m-0 px-4 py-6 text-center text-sm leading-[1.5] text-muted">
              No provider returned lyrics for this song.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
