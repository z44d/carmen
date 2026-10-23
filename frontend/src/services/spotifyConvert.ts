/**
 * Spotify → YouTube Music converter client.
 *
 * The heavy lifting (talking to Spotify, scoring YouTube Music candidates)
 * lives on the FastAPI backend (`server/routes/convert.py`); this module is
 * the typed, abortable client for it, plus the "save the conversion into
 * the local library" step that reuses the app's own playlist repos.
 */
import { ApiError, apiBase, apiGet } from '../api';
import { addTrackToPlaylist, createPlaylist } from '../db/repos/playlists';
import type { Track } from '../types/models';
import { normalizeTrack } from '../utils/track';

/* ── Spotify link parsing (client-side validation mirrors the server) ── */

const PLAYLIST_URL_RE =
  /^(?:https?:\/\/)?open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/([A-Za-z0-9]{22})(?:[?#/].*)?$/i;
const PLAYLIST_URI_RE = /^spotify:playlist:([A-Za-z0-9]{22})$/i;
const BARE_ID_RE = /^([A-Za-z0-9]{22})$/;

/**
 * Extract the Spotify playlist id from a pasted link / URI / bare id.
 * Returns `null` when the input is not recognizable (the dialog shows a
 * hint instead of firing a doomed request).
 */
export function parseSpotifyPlaylistUrl(input: string): string | null {
  const text = (input || '').trim();
  if (!text) return null;
  for (const pattern of [PLAYLIST_URI_RE, PLAYLIST_URL_RE, BARE_ID_RE]) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
  }
  return null;
}

/* ── backend payloads ─────────────────────────────────────────────────── */

export interface SpotifyTrackInfo {
  id: string;
  title: string;
  artists: string[];
  artist: string;
  album: string;
  artwork: string | null;
  duration_ms: number;
  spotify_url: string;
  explicit: boolean;
}

export interface SpotifyPlaylistInfo {
  id: string;
  name: string;
  description: string;
  owner: string;
  artwork: string | null;
  spotify_url: string;
  track_count: number;
  tracks: SpotifyTrackInfo[];
}

export type MatchStatus = 'matched' | 'approximate' | 'not_found' | 'error';

export interface TrackConversion {
  spotify: SpotifyTrackInfo;
  status: MatchStatus;
  /** 0–1 score of the winning YouTube Music candidate. */
  confidence: number;
  /** Raw YouTube Music item (same shape as `/search` results) or null. */
  match: Record<string, unknown> | null;
  error: string | null;
}

export interface ConversionSummary {
  total: number;
  matched: number;
  approximate: number;
  not_found: number;
  error: number;
}

/* ── resolve (preview) ──────────────────────────────────────────────── */

/** Fetch playlist metadata + the Spotify track list (no conversion yet). */
export function resolveSpotifyPlaylist(
  url: string,
  signal?: AbortSignal,
): Promise<SpotifyPlaylistInfo> {
  return apiGet('/convert/spotify/playlist', { url }, signal);
}

/* ── convert (server-sent events) ───────────────────────────────────── */

export interface ConvertProgress {
  done: number;
  total: number;
  result: TrackConversion;
}

export interface ConvertOutcome {
  results: TrackConversion[];
  summary: ConversionSummary;
  playlist: { id: string; name: string; owner: string; artwork: string | null };
}

/**
 * Convert a Spotify playlist to YouTube Music matches.
 *
 * Streams `POST /convert/spotify/to-ytmusic` as server-sent events and
 * calls `onProgress` for every converted track with the real counts — the
 * dialog renders these directly, so progress is never faked.
 */
export function convertSpotifyPlaylist(
  url: string,
  onProgress: (progress: ConvertProgress) => void,
  signal?: AbortSignal,
  limit = 100,
): Promise<ConvertOutcome> {
  return new Promise<ConvertOutcome>((resolvePromise, reject) => {
    const abort = () => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
      }
    };
    if (signal?.aborted) {
      abort();
      return;
    }

    fetch(`${apiBase()}/convert/spotify/to-ytmusic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, limit }),
      signal,
    }).then(
      async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          const detail =
            (payload && (payload.detail || payload.message)) ||
            `Request failed (${response.status})`;
          reject(new ApiError(friendlyConvertError(response.status, String(detail)), response.status, payload));
          return;
        }
        const reader = response.body?.getReader();
        if (!reader) {
          reject(new ApiError('The server did not stream the conversion.', 0, null));
          return;
        }
        const decoder = new TextDecoder();
        let buffer = '';
        let outcome: ConvertOutcome | null = null;
        const results: TrackConversion[] = [];
        let playlist = { id: '', name: '', owner: '', artwork: null as string | null };
        let summary: ConversionSummary = { total: 0, matched: 0, approximate: 0, not_found: 0, error: 0 };

        const handleEvent = (event: string, data: string) => {
          let payload: any = null;
          try {
            payload = JSON.parse(data);
          } catch {
            return;
          }
          if (event === 'start') {
            playlist = {
              id: payload?.playlist?.id ?? '',
              name: payload?.playlist?.name ?? '',
              owner: payload?.playlist?.owner ?? '',
              artwork: payload?.playlist?.artwork ?? null,
            };
          } else if (event === 'progress') {
            const result = payload?.result as TrackConversion;
            if (result) {
              results.push(result);
              onProgress({ done: Number(payload?.done ?? results.length), total: Number(payload?.total ?? 0), result });
            }
          } else if (event === 'done') {
            summary = payload?.summary ?? summary;
            outcome = { results, summary, playlist };
          }
        };

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const chunk = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              let event = '';
              const dataLines: string[] = [];
              for (const line of chunk.split('\n')) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
              }
              if (event) handleEvent(event, dataLines.join('\n'));
              boundary = buffer.indexOf('\n\n');
            }
          }
        } catch (error) {
          if ((error as Error)?.name === 'AbortError') {
            reject(error);
          } else {
            reject(new ApiError('The conversion stream broke — please try again.', 0, null));
          }
          return;
        } finally {
          reader.releaseLock();
        }

        if (outcome) resolvePromise(outcome);
        else reject(new ApiError('The server closed the conversion without a result.', 0, null));
      },
      (error) => {
        if ((error as Error)?.name === 'AbortError') reject(error);
        else reject(new ApiError('Cannot reach the server', 0, null));
      },
    );
  });
}

/** Human-readable errors for the failure modes the dialog must explain. */
export function friendlyConvertError(status: number, detail: string): string {
  if (status === 0) return 'Cannot reach the server — is it running?';
  if (status === 404 && /\/convert\//.test(detail)) {
    return 'This Carmen server is too old for Spotify import — update the server and try again.';
  }
  if (status === 404) {
    return 'Spotify couldn\u2019t find that playlist — it may be private, deleted, or the link is wrong.';
  }
  if (status === 400) return detail;
  if (status === 503) return 'Spotify is busy right now — try again in a minute.';
  return detail || `Conversion failed (${status}).`;
}

/* ── save into the local library ─────────────────────────────────────── */

/** Turn a conversion match into the app's normalized track shape. */
export function conversionToTrack(conversion: TrackConversion): Track | null {
  if (!conversion.match) return null;
  return normalizeTrack(conversion.match);
}

export interface SaveConversionOptions {
  /** Playlist name shown in the library. */
  name: string;
  /** Only these conversions are saved (defaults to every usable match). */
  selected?: TrackConversion[];
  description?: string;
}

/**
 * Create a library playlist from conversion results and add every usable
 * match through the same path the rest of the app uses, so the songs are
 * playable, downloadable and offline-capable like any other track.
 *
 * Returns the new playlist id.
 */
export async function saveConversionAsPlaylist(
  conversions: TrackConversion[],
  options: SaveConversionOptions,
): Promise<number> {
  const selected =
    options.selected ?? conversions.filter((c) => c.match && c.status !== 'not_found');
  const playlistId = await createPlaylist(
    options.name.trim() || 'Imported from Spotify',
    options.description ?? '',
  );
  for (const conversion of selected) {
    const track = conversionToTrack(conversion);
    if (track) {
      await addTrackToPlaylist(playlistId, track);
    }
  }
  return playlistId;
}
