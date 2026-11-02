/**
 * Shared fetch helpers for the client-side lyrics providers.
 *
 * Browser limits are honoured here: no `User-Agent` header is ever set
 * (it is a forbidden fetch header and would be silently ignored), and
 * no `Content-Type` is sent on GETs. Transport failures throw so the
 * chain can mark the provider failed and fall back to the Carmen
 * server endpoint for exactly that provider — one provider failing
 * must never break the chain.
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
 */

export type FetchParams = Record<string, string | number | boolean | undefined | null>;

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
  relay?: 'allorigins' | 'codetabs';
}

/**
 * Public CORS relays, tried in order, GET-only, no key. Each relay URL
 * is built from the FULL target URL (query string included),
 * percent-encoded exactly once with `encodeURIComponent`.
 */
export function relayUrlsFor(
  targetUrl: string,
): { name: 'allorigins' | 'codetabs'; url: string }[] {
  const encoded = encodeURIComponent(targetUrl);
  return [
    { name: 'allorigins', url: `https://api.allorigins.win/raw?url=${encoded}` },
    { name: 'codetabs', url: `https://api.codetabs.com/v1/proxy?quest=${encoded}` },
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

async function fetchOnce(
  url: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
): Promise<FetchResult> {
  const response = await fetch(url, { headers, signal });
  const text = await response.text();
  return { status: response.status, text };
}

/**
 * Try the relays for *targetUrl* with the same `signal` the chain gave
 * the provider, so the relay attempts share the provider's 8s budget:
 * a direct failure is fast (a CORS rejection is immediate), so the
 * relay gets the remaining time, and direct + relay can never exceed
 * the budget the chain enforces. A relay failure (reject, timeout via
 * the shared signal, or non-2xx) is swallowed here and returns `null`
 * — it never throws, and never surfaces to the caller.
 */
async function tryRelays(
  targetUrl: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
): Promise<FetchResult | null> {
  for (const relay of relayUrlsFor(targetUrl)) {
    if (signal?.aborted) return null;
    try {
      const result = await fetchOnce(relay.url, relayHeaders(headers), signal);
      if (result.status >= 200 && result.status <= 299) {
        return { ...result, via: 'relay', relay: relay.name };
      }
    } catch {
      // Relay down / blocked / timed out: try the next relay, then
      // fall through to the caller (chain → server fallback).
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
  const result = await fetchOnce(buildUrl(url, params), headers, signal);
  return { ...result, via: 'direct' };
}

/**
 * GET with the three-layer fetch order, all driven from the browser:
 *
 * 1. Direct fetch to the provider origin.
 * 2. CORS relay (AllOrigins, then Codetabs) when the direct fetch
 *    fails to *read* a response — a transport/CORS rejection — or
 *    answers non-2xx, which a relay might bypass. Relay attempts
 *    share the caller's `AbortSignal` (the provider's 8s budget).
 * 3. Nothing here: the chain/picker's Carmen-server fallback (layer
 *    3) runs only for providers this helper reports as failed, i.e.
 *    when the direct fetch threw and every relay failed too. That
 *    failure is reported by rethrowing the direct error after the
 *    relays have been tried and swallowed — the chain catches it,
 *    marks the provider failed, and the picker falls back to the
 *    server for that id only. A provider that *answers* non-2xx
 *    (even after the relays) is not a transport failure: the direct
 *    result is returned and the provider treats it as "no lyrics".
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
    direct = await fetchOnce(target, headers, signal);
  } catch (error) {
    const relayed = await tryRelays(target, headers, signal);
    if (relayed) return relayed;
    throw error;
  }
  if (direct.status >= 200 && direct.status <= 299) {
    return { ...direct, via: 'direct' };
  }
  const relayed = await tryRelays(target, headers, signal);
  if (relayed) return relayed;
  return { ...direct, via: 'direct' };
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

/** GET *url* via `fetchTextWithRelay`, decoded as JSON; `null` on non-2xx / bad JSON. */
export async function fetchJsonWithRelay(
  url: string,
  params?: FetchParams,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const { status, text } = await fetchTextWithRelay(url, params, headers, signal);
  if (status < 200 || status > 299) return null;
  return parseJsonLenient(text);
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
