/**
 * Shared fetch helpers for the client-side lyrics providers. Lyrics
 * are fetched entirely in the browser: there is no server fallback
 * anywhere in this layer. Every provider runs direct-first, then
 * through public CORS relays for origins that send no
 * `Access-Control-Allow-Origin` header.
 *
 * Browser limits are honoured here: no `User-Agent` header is ever set
 * (it is a forbidden fetch header and would be silently ignored), and
 * no `Content-Type` is sent on GETs. Transport failures throw so the
 * chain can mark the provider failed — one provider failing must
 * never break the chain.
 *
 * WHY A CORS RELAY EXISTS (layer 2 of the fetch order)
 * ---------------------------------------------------
 * Whether a browser may read a cross-origin response is decided by
 * the *provider's* server, in its `Access-Control-Allow-Origin`
 * header. No browser flag, header, or fetch option can force a
 * browser to read a response from an origin that sends no such
 * header — the browser blocks the read before the app ever sees the
 * body, however correct the request is. A CORS relay is therefore
 * the only browser-originated way to read a response from such an
 * origin: the relay (a different origin that *does* send
 * `Access-Control-Allow-Origin`) fetches the provider URL
 * server-side and returns the body to the browser. The relay only
 * ever carries the provider's public query parameters (title,
 * artist, album, duration, video id). It never carries secrets: see
 * `fetchTextWithRelay` — relay requests strip every header except
 * `Accept`, and Paxsenix never uses the relay at all.
 *
 * RELAY HEALTH (probed live 2026-11-02 evening, 63 requests, 3
 * tracks × 7 providers × 3 transports): AllOrigins is currently
 * failing on almost every upstream — Cloudflare 522s after ~20s,
 * 500s and 408s — while cors.dev answers the same upstreams with
 * real 200 payloads in ~1s. The old order (AllOrigins first, both
 * attempts sharing the provider's single 8s AbortSignal) therefore
 * burned the whole budget inside the broken relay and cors.dev was
 * never reached: every relayed provider failed and the picker
 * reported "No lyrics found" for lyrics that exist. The order is
 * now cors.dev first, AllOrigins last-resort, and EVERY attempt has
 * its own timeout so one hanging relay can never starve the next.
 * Codetabs is DEAD — its proxy was shut down in June 2026 and the
 * repository archived — so it is not in the chain. corsproxy.io
 * requires an API key and cors.lol rate-limited from this sandbox,
 * so neither is used: no hardcoded keys anywhere.
 *
 * ATTEMPT TIMEOUTS
 * ----------------
 * Each attempt (direct, each relay) gets its own timeout, derived
 * from a fresh AbortController merged with the caller's signal. The
 * caller's signal is never passed straight through: sharing one
 * signal across sequential attempts meant the first attempt's
 * timeout aborted every later attempt before it started.
 */

export type FetchParams = Record<string, string | number | boolean | undefined | null>;

/** Per-attempt timeout for the direct fetch (a CORS rejection is instant; a hung origin is not). */
export const DIRECT_ATTEMPT_TIMEOUT_MS = 4000;
/** Per-attempt timeout for each relay fetch. */
export const RELAY_ATTEMPT_TIMEOUT_MS = 6000;
/** Delay before a single retry of a relay that answered 429 (shared relay IPs get rate-limited). */
export const RELAY_RATE_LIMIT_RETRY_MS = 1000;

export function buildUrl(base: string, params?: FetchParams): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export interface FetchResult {
  status: number;
  text: string;
  /** Which layer produced this result (absent = direct-only helper). */
  via?: 'direct' | 'relay';
  /** Relay that produced a relay result, when `via` is `'relay'`. */
  relay?: 'corsdev' | 'allorigins';
}

/**
 * Public CORS relays, tried in order, GET-only, no key. cors.dev
 * takes the target URL unencoded, appended after its prefix, query
 * string left as-is. AllOrigins takes the FULL target URL (query
 * string included) percent-encoded exactly once. Order matters:
 * cors.dev is healthy and fast (probed live 2026-11-02); AllOrigins
 * currently 522s/500s on most upstreams and is only a last resort.
 */
export function relayUrlsFor(
  targetUrl: string,
): { name: 'corsdev' | 'allorigins'; url: string }[] {
  return [
    { name: 'corsdev', url: `https://proxy.cors.dev/${targetUrl}` },
    { name: 'allorigins', url: `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}` },
  ];
}

/** Headers safe to send to a relay: `Accept` only. Never secrets. */
function relayHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;
  const accept = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === 'accept',
  )?.[1];
  return accept ? { Accept: accept } : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One fetch attempt with its OWN timeout: the attempt is aborted
 * when either the caller's signal fires or `timeoutMs` elapses,
 * whichever comes first. The caller's signal is never reused
 * directly, so a timeout here cannot poison a later attempt.
 */
async function fetchOnce(
  url: string,
  headers: Record<string, string> | undefined,
  outerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<FetchResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = () => controller.abort();
  outerSignal?.addEventListener('abort', onOuterAbort, { once: true });
  try {
    const response = await Promise.race([
      fetch(url, { headers, signal: controller.signal }).then(async (r) => ({
        status: r.status,
        text: await r.text(),
      })),
      new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => {
            if (timedOut) {
              const error = new Error(`fetch timed out after ${timeoutMs}ms: ${url}`);
              error.name = 'TimeoutError';
              reject(error);
            } else {
              reject(outerSignal?.reason ?? new Error('aborted'));
            }
          },
          { once: true },
        );
      }),
    ]);
    return response;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Try the relays for *targetUrl*, each with its own timeout. A relay
 * failure (reject, timeout, non-2xx, or an empty body — an upstream
 * error page the relay passed through as 200) is skipped and the
 * next relay is tried; a 429 is retried once after a short delay,
 * because shared relay IPs are rate-limited transiently. When every
 * relay fails, `null` is returned. It never throws, and never
 * surfaces to the caller.
 */
async function tryRelays(
  targetUrl: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
): Promise<FetchResult | null> {
  for (const relay of relayUrlsFor(targetUrl)) {
    if (signal?.aborted) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) return null;
      try {
        const result = await fetchOnce(
          relay.url,
          relayHeaders(headers),
          signal,
          RELAY_ATTEMPT_TIMEOUT_MS,
        );
        if (result.status === 429 && attempt === 0) {
          await sleep(RELAY_RATE_LIMIT_RETRY_MS, signal);
          continue;
        }
        if (result.status >= 200 && result.status <= 299 && result.text.trim()) {
          return { ...result, via: 'relay', relay: relay.name };
        }
        break;
      } catch (error) {
        // Relay down / blocked / timed out: try the next relay.
        void error;
        break;
      }
    }
  }
  return null;
}

/**
 * GET *url*; returns `{status, body}`. Direct-only — no relay.
 * Used by Paxsenix (direct-only: its `Authorization` header must
 * never travel through a relay) and by any caller that must not
 * leave the provider origin. Throws on transport errors.
 */
export async function fetchText(
  url: string,
  params?: FetchParams,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const result = await fetchOnce(buildUrl(url, params), headers, signal, DIRECT_ATTEMPT_TIMEOUT_MS);
  return { ...result, via: 'direct' };
}

/**
 * GET with the two-layer fetch order, all driven from the browser:
 *
 * 1. Direct fetch to the provider origin (own timeout).
 * 2. CORS relays (cors.dev, then AllOrigins) when the direct fetch
 *    fails to *read* a response — a transport/CORS rejection — or
 *    answers non-2xx or with an empty body, which a relay might
 *    bypass. Every relay attempt has its own timeout: a hanging
 *    relay can never consume the budget of the next one. There is
 *    no third layer: when direct and every relay fail, the direct
 *    error is rethrown so the chain marks the provider failed and
 *    the picker can say so honestly.
 *
 * A provider that *answers* non-2xx (even after the relays) is not
 * a transport failure: the direct result is returned and the
 * provider treats it as "no lyrics" or an upstream failure by
 * status (see `throwIfUpstreamFailure`). An empty 2xx body is
 * different — it carries nothing to parse, so the relays are still
 * tried before giving up on the transport.
 *
 * Throws on transport errors (after the relays). Relay requests
 * carry no secrets: headers are stripped to `Accept` only.
 */
export async function fetchTextWithRelay(
  url: string,
  params?: FetchParams,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const target = buildUrl(url, params);
  let direct: FetchResult;
  try {
    direct = await fetchOnce(target, headers, signal, DIRECT_ATTEMPT_TIMEOUT_MS);
  } catch (error) {
    const relayed = await tryRelays(target, headers, signal);
    if (relayed) return relayed;
    throw error;
  }
  if (direct.status >= 200 && direct.status <= 299 && direct.text.trim()) {
    return { ...direct, via: 'direct' };
  }
  const relayed = await tryRelays(target, headers, signal);
  if (relayed) return relayed;
  return { ...direct, via: 'direct' };
}

/**
 * Upstream failure statuses: the provider answered, but the answer
 * is a failure, not "no lyrics". 401/403 = the upstream now gates
 * the query (BetterLyrics/Portato uncached queries require an API
 * key since 2026-11-02; SimpMusic rejects non-SimpMusic clients);
 * 429/5xx = rate-limited / overloaded. Providers throw on these so
 * the chain marks them failed and the picker shows "Couldn't reach
 * provider" instead of "No lyrics found". 404 and other 4xx stay
 * "no lyrics": the query simply matched nothing.
 */
export function isUpstreamFailureStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

/** Throw when *result* carries an upstream failure status (see above). */
export function throwIfUpstreamFailure(result: FetchResult): void {
  if (isUpstreamFailureStatus(result.status)) {
    throw new Error(`Upstream request failed with HTTP ${result.status}`);
  }
}

/** GET *url* and decode its JSON body; `null` on non-2xx / bad JSON. Direct-only. */
export async function fetchJson(
  url: string,
  params?: FetchParams,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const { status, text } = await fetchText(url, params, headers, signal);
  if (status < 200 || status > 299) return null;
  return parseJsonLenient(text);
}

/**
 * GET *url* via `fetchTextWithRelay`, decoded as JSON. Throws on
 * upstream failure statuses (401/403/429/5xx) so the chain marks
 * the provider failed; `null` on other non-2xx / bad JSON (the
 * query matched nothing).
 */
export async function fetchJsonWithRelay(
  url: string,
  params?: FetchParams,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const result = await fetchTextWithRelay(url, params, headers, signal);
  throwIfUpstreamFailure(result);
  if (result.status < 200 || result.status > 299) return null;
  return parseJsonLenient(result.text);
}

/** Decode JSON, returning `null` instead of throwing. */
export function parseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Base64 (standard alphabet) decoded as UTF-8, for KuGou downloads. */
export function decodeBase64Utf8(content: string): string {
  const binary = decodeBase64Binary(content);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
  return new TextDecoder('utf-8').decode(bytes);
}

function decodeBase64Binary(content: string): string {
  const atobFn = (globalThis as { atob?: (s: string) => string }).atob;
  if (typeof atobFn === 'function') return atobFn(content);
  const bufferCtor = (globalThis as { Buffer?: { from(s: string, e: string): { toString(e: string): string } } }).Buffer;
  if (bufferCtor) return bufferCtor.from(content, 'base64').toString('binary');
  throw new Error('no base64 decoder available');
}
