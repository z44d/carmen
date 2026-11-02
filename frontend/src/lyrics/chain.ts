/**
 * Client-side provider chain — a TypeScript port of
 * `server/lyrics/chain.py` (Android `LyricsHelper` semantics).
 *
 * Providers run concurrently (max 6, 8s per provider, 12s overall).
 * The single-result path ranks by quality — word-synced (2) >
 * line-synced/TTML (1) > plain (0), preferring the lower registry
 * order on ties — with the same grace periods: after the first
 * candidate, up to 1500ms more, or 350ms when the best candidate is
 * word-synced and every earlier-order provider has finished. The
 * all-results path returns every provider's parsed result,
 * deduplicated on identical (synced, unsynced) pairs, in registry
 * order. Per-provider failures and timeouts never throw.
 *
 * Results are memoised per song (videoId + order + enabled + a
 * keyed/not-keyed flag — the Paxsenix key itself is never part of
 * the memo key), and failures are evicted so they retry, like
 * `trackMetaCache` in `api.ts`.
 */
import type { LyricLine, ProviderLyricsResult } from '../types/models';
import { LYRICS_CHAIN_IDS } from '../types/models';
import { normalizeProviderOrder } from '../utils/lyricsProviders';
import { parseLyrics, type ParsedLyrics } from './parse';
import {
  getProviderRegistry,
  isProviderAvailable,
  providerName,
  resolveClientOrder,
  type ProviderContext,
  type ProviderDefinition,
} from './providers';

export const MAX_CONCURRENT_PROVIDERS = 6;
export const FETCH_TIMEOUT_MS = 12000;
export const PROVIDER_TIMEOUT_MS = 8000;
export const QUALITY_GRACE_MS = 1500;
export const PROVIDER_PRIORITY_GRACE_MS = 350;
export const WORD_SYNCED_QUALITY = 2;

export interface ClientLyricsQuery {
  videoId: string;
  title?: string;
  artist?: string;
  album?: string;
  durationSeconds?: number;
  order?: string[];
  enabled?: Record<string, boolean>;
  paxsenixKey?: string;
}

export interface ClientBestLyrics {
  provider: string;
  name: string;
  synced: LyricLine[] | null;
  unsynced: string | null;
  quality: 0 | 1 | 2;
}

export interface ClientProviderEntry extends ProviderLyricsResult {
  /**
   * Whether the provider failed after every browser layer:
   * direct fetch AND both CORS relays (transport/CORS/network/
   * timeout). A provider that answered — even with a non-2xx
   * status or no lyrics — is not marked failed here; the picker
   * still sends empty providers to the server fallback, because
   * an answer the browser cannot read (CORS/rate-limit page) may
   * succeed from the server.
   */
  directFailed: boolean;
  /** Server-only providers never run in the browser (YouTube Music). */
  serverOnly: boolean;
  quality: number | null;
}

function toContext(query: ClientLyricsQuery): ProviderContext {
  return {
    videoId: query.videoId ?? '',
    title: query.title ?? '',
    artist: query.artist ?? '',
    album: query.album ?? '',
    durationSeconds: query.durationSeconds ?? null,
    paxsenixKey: query.paxsenixKey?.trim() || undefined,
  };
}

function parseResult(raw: string | null, durationSeconds: number | null): ParsedLyrics | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const parsed = parseLyrics(raw, durationSeconds);
  if (parsed.synced == null && parsed.unsynced == null) return null;
  return parsed;
}

function memoKey(query: ClientLyricsQuery, kind: string): string {
  const order = normalizeProviderOrder(query.order);
  const enabledIds = order.filter((id) => query.enabled?.[id] !== false);
  return [
    kind,
    query.videoId ?? '',
    order.join(','),
    enabledIds.join(','),
    query.paxsenixKey?.trim() ? 'keyed' : '',
  ].join(':');
}

const bestCache = new Map<string, Promise<ClientBestLyrics | null>>();
const allCache = new Map<string, Promise<ClientProviderEntry[]>>();

function cachePromise<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  factory: () => Promise<T>,
): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached;
  const promise = factory().catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, promise);
  return promise;
}

interface JobResult {
  index: number;
  parsed: ParsedLyrics[];
  failed: boolean;
}

function bestCandidate(
  results: Map<number, ParsedLyrics[]>,
): { index: number; parsed: ParsedLyrics } | null {
  let best: { index: number; parsed: ParsedLyrics } | null = null;
  for (const index of [...results.keys()].sort((a, b) => a - b)) {
    for (const parsed of results.get(index) ?? []) {
      if (!best) {
        best = { index, parsed };
        continue;
      }
      if (
        parsed.quality > best.parsed.quality ||
        (parsed.quality === best.parsed.quality && index < best.index)
      ) {
        best = { index, parsed };
      }
    }
  }
  return best;
}

interface CollectOutcome {
  results: Map<number, ParsedLyrics[]>;
  finished: Set<number>;
  failed: Set<number>;
}

/**
 * Run provider jobs with a 6-worker pool, an 8s per-provider budget
 * and a 12s overall budget, polling like the Python collector so the
 * grace-period rules can shorten the deadline as candidates arrive.
 */
async function collectWithBudget(
  jobs: { providerId: string; run: (signal: AbortSignal) => Promise<ParsedLyrics[]> }[],
  wantAll: boolean,
  outerSignal?: AbortSignal,
): Promise<CollectOutcome> {
  const started = Date.now();
  let deadline = started + FETCH_TIMEOUT_MS;
  const results = new Map<number, ParsedLyrics[]>();
  const finished = new Set<number>();
  const failed = new Set<number>();
  const controllers = new Map<number, AbortController>();
  let nextIndex = 0;
  const running = new Map<number, Promise<JobResult>>();
  const jobStartedAt = new Map<number, number>();

  const startJob = (index: number) => {
    const job = jobs[index];
    const controller = new AbortController();
    controllers.set(index, controller);
    jobStartedAt.set(index, Date.now());
    const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    const promise: Promise<JobResult> = (async () => {
      try {
        const parsed = await job.run(controller.signal);
        return { index, parsed, failed: false };
      } catch {
        return { index, parsed: [], failed: true };
      } finally {
        clearTimeout(timer);
      }
    })();
    running.set(index, promise);
    void promise.then((result) => {
      running.delete(index);
      finished.add(index);
      results.set(index, result.parsed);
      if (result.failed) failed.add(index);
    });
  };

  const shouldStopEarly = (): boolean => {
    if (wantAll) return false;
    const best = bestCandidate(results);
    if (!best || best.parsed.quality !== WORD_SYNCED_QUALITY) return false;
    for (let i = 0; i < best.index; i++) {
      if (!finished.has(i)) return false;
    }
    return true;
  };

  const currentDeadline = (): number => {
    const best = bestCandidate(results);
    if (!best) return deadline;
    const now = Date.now();
    const grace =
      best.parsed.quality === WORD_SYNCED_QUALITY &&
      Array.from({ length: best.index }, (_, i) => i).every((i) => finished.has(i))
        ? PROVIDER_PRIORITY_GRACE_MS
        : QUALITY_GRACE_MS;
    return Math.min(deadline, now + grace);
  };

  try {
    while (true) {
      while (running.size < MAX_CONCURRENT_PROVIDERS && nextIndex < jobs.length) {
        startJob(nextIndex);
        nextIndex += 1;
      }
      if (nextIndex >= jobs.length && running.size === 0) break;
      const now = Date.now();
      if (now >= deadline || outerSignal?.aborted) break;
      if (shouldStopEarly()) break;
      if (!wantAll) deadline = currentDeadline();
      // Expire overrunning providers: mark finished, abort, ignore late results.
      for (const [index, promise] of [...running.entries()]) {
        if (now - (jobStartedAt.get(index) ?? now) > PROVIDER_TIMEOUT_MS) {
          controllers.get(index)?.abort();
          finished.add(index);
          failed.add(index);
          running.delete(index);
          void promise.catch(() => undefined);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      // Collect anything that finished while polling.
      if (shouldStopEarly()) break;
      if (!wantAll) deadline = currentDeadline();
      if (nextIndex >= jobs.length && running.size === 0) break;
    }
  } finally {
    for (const controller of controllers.values()) controller.abort();
  }
  // Any job still running past the deadline counts as finished/failed
  // for the caller's purposes; its late result is ignored.
  for (let i = 0; i < jobs.length; i++) {
    if (!finished.has(i)) {
      finished.add(i);
      if (!results.has(i)) {
        failed.add(i);
        results.set(i, []);
      }
    }
  }
  return { results, finished, failed };
}

async function runChainInternal(
  query: ClientLyricsQuery,
  wantAll: boolean,
  outerSignal?: AbortSignal,
): Promise<{ best: ClientBestLyrics | null; entries: ClientProviderEntry[] }> {
  const registry = await getProviderRegistry();
  const byId = new Map(registry.map((def) => [def.id, def]));
  const order = resolveClientOrder(query.order, query.enabled);
  const ctx = toContext(query);
  const duration = ctx.durationSeconds;
  const keyed = Boolean(ctx.paxsenixKey);

  const runnable = order.filter((id) => {
    const def = byId.get(id);
    // Server-only providers never run in the browser; their entry
    // is built below with available:false and serverOnly:true so the
    // picker merges the server result for them.
    return def != null && !def.serverOnly && isProviderAvailable(def, ctx.paxsenixKey);
  });

  const jobs = runnable.map((providerId, index) => {
    const def = byId.get(providerId)!;
    return {
      providerId,
      run: async (signal: AbortSignal): Promise<ParsedLyrics[]> => {
        const raws = wantAll
          ? await def.getAllLyrics(ctx, signal)
          : await (async () => {
              const raw = await def.getLyrics(ctx, signal);
              return raw ? [raw] : [];
            })();
        const parsed: ParsedLyrics[] = [];
        for (const raw of raws) {
          const result = parseResult(raw, duration);
          if (result) parsed.push(result);
        }
        return parsed;
      },
      index,
    };
  });

  const { results, failed } = await collectWithBudget(jobs, wantAll, outerSignal);

  // Build entries in the requested order, including unavailable/empty
  // providers, deduplicated on identical (synced, unsynced) pairs.
  const entries: ClientProviderEntry[] = [];
  const seen = new Set<string>();
  const runnableIndex = new Map(runnable.map((id, idx) => [id, idx]));
  for (const providerId of order) {
    const def = byId.get(providerId);
    const name = def?.name ?? providerName(providerId);
    const available = def != null && !def.serverOnly && isProviderAvailable(def, ctx.paxsenixKey);
    if (!available) {
      entries.push({
        provider: providerId,
        name,
        available: false,
        synced: null,
        unsynced: null,
        source: null,
        directFailed: false,
        serverOnly: def?.serverOnly ?? false,
        quality: null,
      });
      continue;
    }
    const parsedList = results.get(runnableIndex.get(providerId) ?? -1) ?? [];
    const wasFailed = failed.has(runnableIndex.get(providerId) ?? -1);
    if (!parsedList.length) {
      entries.push({
        provider: providerId,
        name,
        available: true,
        synced: null,
        unsynced: null,
        source: null,
        directFailed: wasFailed,
        serverOnly: false,
        quality: null,
      });
      continue;
    }
    for (const parsed of parsedList) {
      const key = JSON.stringify({ synced: parsed.synced, unsynced: parsed.unsynced });
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        provider: providerId,
        name,
        available: true,
        synced: parsed.synced,
        unsynced: parsed.unsynced,
        source: name,
        directFailed: false,
        serverOnly: false,
        quality: parsed.quality,
      });
    }
  }
  // Providers whose fetch failed but which also produced a parsed
  // result (partial) are not "failed" for fallback purposes. The
  // picker sends every empty provider (failed, answered-empty, or
  // server-only) to the server fallback; directFailed only records
  // that the browser layers themselves failed.

  let best: ClientBestLyrics | null = null;
  if (entries.length) {
    // Re-derive the best from the finished jobs, in registry order.
    const bestFromJobs = bestCandidate(results);
    if (bestFromJobs) {
      const providerId = runnable[bestFromJobs.index];
      const parsed = bestFromJobs.parsed;
      best = {
        provider: providerId,
        name: providerName(providerId),
        synced: parsed.synced,
        unsynced: parsed.unsynced,
        quality: parsed.quality,
      };
    }
  }
  void keyed;
  return { best, entries };
}

/** Best parsed lyrics across providers, or `null`. Memoised per song. */
export function fetchClientBestLyrics(
  query: ClientLyricsQuery,
  signal?: AbortSignal,
): Promise<ClientBestLyrics | null> {
  return cachePromise(bestCache, memoKey(query, 'best'), () =>
    runChainInternal(query, false, signal).then(({ best }) => best),
  );
}

/** Every provider's parsed results, in chain order, deduplicated. Memoised per song. */
export function fetchClientProviderResults(
  query: ClientLyricsQuery,
  signal?: AbortSignal,
): Promise<ClientProviderEntry[]> {
  return cachePromise(allCache, memoKey(query, 'all'), () =>
    runChainInternal(query, true, signal).then(({ entries }) => entries),
  );
}

/**
 * One provider's lyrics for a song (the pin path): the first parsed
 * result from that provider's all-results fetch, or `null`.
 */
export async function fetchClientProviderLyrics(
  query: ClientLyricsQuery & { provider: string },
  signal?: AbortSignal,
): Promise<ClientBestLyrics | null> {
  const entries = await fetchClientProviderResults(
    { ...query, order: [query.provider], enabled: { [query.provider]: true } },
    signal,
  );
  const entry = entries.find(
    (e) => e.provider === query.provider && (e.synced?.length || e.unsynced?.trim()),
  );
  if (!entry) return null;
  return {
    provider: entry.provider,
    name: entry.name,
    synced: entry.synced,
    unsynced: entry.unsynced,
    quality: (entry.quality ?? 0) as 0 | 1 | 2,
  };
}

/** Chain ids in the default registry order (for tests / diagnostics). */
export function defaultClientOrder(): string[] {
  return [...LYRICS_CHAIN_IDS];
}

export type { ProviderDefinition };
