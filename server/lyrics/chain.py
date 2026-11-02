"""Concurrent provider chain — a port of ``LyricsHelper``'s fetching.

Providers run concurrently (max 6 workers, 8s per provider, 12s overall).
The single-result path ranks candidates by Android quality — word-synced
(2) > line-synced/TTML (1) > plain (0), preferring the lower registry
order on ties — and applies the same grace periods: after the first
candidate, wait up to 1500ms more, or 350ms when the best candidate is
word-synced and every earlier-order provider has finished. The
all-results path returns every provider's parsed result, deduplicated on
identical (synced, unsynced) pairs, in registry order.

Per-provider failures and timeouts never raise. There is no in-memory
caching here — the route-level ``@cached`` handles that.
"""

from __future__ import annotations

import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor, wait

from . import (
    call_get_all_lyrics,
    call_get_lyrics,
    get_name,
    is_available,
    resolve_order,
)
from .parse import parse_lyrics

log = logging.getLogger(__name__)

MAX_CONCURRENT_PROVIDERS = 6
FETCH_TIMEOUT_SECONDS = 12.0
PROVIDER_TIMEOUT_SECONDS = 8.0
QUALITY_GRACE_SECONDS = 1.5
PROVIDER_PRIORITY_GRACE_SECONDS = 0.35
WORD_SYNCED_QUALITY = 2


def _parse_result(raw, duration_seconds):
    if not isinstance(raw, str) or not raw.strip():
        return None
    parsed = parse_lyrics(raw, duration_seconds)
    if parsed["synced"] is None and parsed["unsynced"] is None:
        return None
    return parsed


def _call_provider(provider_id, video_id, title, artist, album, duration_seconds, api_key, want_all, browse_id=None):
    """Run one provider (single or all variants) and parse its results."""
    if want_all:
        raws = call_get_all_lyrics(
            provider_id, video_id, title, artist, album, duration_seconds, api_key,
            browse_id=browse_id,
        )
        parsed_results = []
        for raw in raws or []:
            parsed = _parse_result(raw, duration_seconds)
            if parsed is not None:
                parsed_results.append(parsed)
        return parsed_results
    raw = call_get_lyrics(
        provider_id, video_id, title, artist, album, duration_seconds, api_key,
        browse_id=browse_id,
    )
    parsed = _parse_result(raw, duration_seconds)
    return [parsed] if parsed is not None else []


def _safe_call(provider_id, video_id, title, artist, album, duration_seconds, api_key, want_all, browse_id=None):
    try:
        return _call_provider(
            provider_id, video_id, title, artist, album,
            duration_seconds, api_key, want_all, browse_id=browse_id,
        )
    except Exception as exc:  # noqa: BLE001 — a provider must never break the chain
        log.debug("lyrics provider %s failed: %s", provider_id, exc)
        return []


def _collect_with_budget(submit, order, want_all):
    """Submit all jobs, honouring the 8s-per-provider / 12s-overall budget.

    *submit* is ``submit(executor, provider_id, index) -> Future``.
    Returns ``(results_by_index, finished_indices)`` where finished means
    the job completed or timed out.
    """
    started = time.monotonic()
    deadline = started + FETCH_TIMEOUT_SECONDS
    results: dict[int, list[dict]] = {}
    finished: set[int] = set()
    # No context manager: exiting a ThreadPoolExecutor waits for every
    # submitted future, which would let one overrunning provider eat the
    # whole budget. shutdown(wait=False) lets timed-out calls finish in
    # the background on their own HTTP timeout instead.
    pool = ThreadPoolExecutor(max_workers=MAX_CONCURRENT_PROVIDERS)
    try:
        futures = {}
        submitted_at = {}
        for index, provider_id in enumerate(order):
            future = submit(pool, provider_id, index)
            futures[future] = index
            submitted_at[future] = time.monotonic()
        pending = set(futures)
        while pending:
            now = time.monotonic()
            remaining = deadline - now
            if remaining <= 0:
                break
            done, pending = wait(pending, timeout=min(remaining, 0.05))
            now = time.monotonic()
            for future in list(done):
                index = futures[future]
                finished.add(index)
                try:
                    results[index] = future.result()
                except Exception:
                    results[index] = []
            # Expire providers that overran their own budget; their late
            # results are ignored, exactly like a coroutine timeout.
            for future in list(pending):
                if now - submitted_at[future] > PROVIDER_TIMEOUT_SECONDS:
                    finished.add(futures[future])
                    pending.discard(future)
            if _should_stop_early(order, results, finished, want_all):
                break
            # The grace-period rule applies to the single-result path
            # only; the all-results path waits out the full budget.
            if not want_all:
                deadline = _current_deadline(order, results, finished, started, deadline)
        for future in pending:
            future.cancel()
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    return results, finished


def _best_candidate(results: dict[int, list[dict]]):
    """Best (index, parsed) across finished jobs, Android ranking."""
    best = None
    for index in sorted(results):
        for parsed in results[index]:
            if best is None:
                best = (index, parsed)
                continue
            _, best_parsed = best
            if parsed["quality"] > best_parsed["quality"] or (
                parsed["quality"] == best_parsed["quality"] and index < best[0]
            ):
                best = (index, parsed)
    return best


def _should_stop_early(order, results, finished, want_all) -> bool:
    if want_all:
        return False
    best = _best_candidate(results)
    if best is None or best[1]["quality"] != WORD_SYNCED_QUALITY:
        return False
    return all(i in finished for i in range(best[0]))


def _current_deadline(order, results, finished, started, deadline):
    """Apply the grace-period rule after the first candidate arrives."""
    best = _best_candidate(results)
    if best is None:
        return deadline
    now = time.monotonic()
    if best[1]["quality"] == WORD_SYNCED_QUALITY and all(
        i in finished for i in range(best[0])
    ):
        grace = PROVIDER_PRIORITY_GRACE_SECONDS
    else:
        grace = QUALITY_GRACE_SECONDS
    # Only ever shorten the overall deadline, and only once the grace
    # window is the binding constraint — mirroring minOf(deadline, now+grace).
    return min(deadline, now + grace)


def run_chain(
    video_id,
    title,
    artist,
    album,
    duration_seconds,
    lyrics_order: list[str] | None = None,
    lyrics_enabled: set[str] | None = None,
    paxsenix_key: str | None = None,
    browse_id: str | None = None,
):
    """Best parsed lyrics across providers, or ``None``.

    Returns ``{"provider", "name", "synced", "unsynced", "quality"}``.
    ``browse_id`` is the lyrics browse id (``MPLYt…``) threaded to the
    YouTube Music provider; without it that provider resolves it from
    the video id itself.
    """
    order = resolve_order(lyrics_order, lyrics_enabled)
    order = [pid for pid in order if is_available(pid, paxsenix_key)]
    if not order:
        return None
    duration = duration_seconds if duration_seconds else None

    def submit(pool, provider_id, index):
        return pool.submit(
            _safe_call,
            provider_id, video_id, title, artist, album, duration,
            paxsenix_key, False, browse_id,
        )

    results, _finished = _collect_with_budget(submit, order, want_all=False)
    best = _best_candidate(results)
    if best is None:
        return None
    index, parsed = best
    provider_id = order[index]
    return {
        "provider": provider_id,
        "name": get_name(provider_id),
        "synced": parsed["synced"],
        "unsynced": parsed["unsynced"],
        "quality": parsed["quality"],
    }


def run_chain_all(
    video_id,
    title,
    artist,
    album,
    duration_seconds,
    lyrics_order: list[str] | None = None,
    lyrics_enabled: set[str] | None = None,
    paxsenix_key: str | None = None,
    browse_id: str | None = None,
):
    """Every provider's parsed results, in registry order, deduplicated.

    Returns a list of ``{"provider", "name", "available", "synced",
    "unsynced", "quality"}`` — one entry per selected provider, including
    providers that returned nothing (``synced``/``unsynced`` ``None``).
    Dedup drops later entries whose (synced, unsynced) pair is identical
    to an earlier one. ``browse_id`` is threaded to the YouTube Music
    provider as in :func:`run_chain`.
    """
    order = resolve_order(lyrics_order, lyrics_enabled)
    if not order:
        return []
    duration = duration_seconds if duration_seconds else None

    runnable = [pid for pid in order if is_available(pid, paxsenix_key)]

    def submit(pool, provider_id, index):
        return pool.submit(
            _safe_call,
            provider_id, video_id, title, artist, album, duration,
            paxsenix_key, True, browse_id,
        )

    results, _finished = _collect_with_budget(submit, runnable, want_all=True)
    runnable_index = {pid: idx for idx, pid in enumerate(runnable)}

    entries = []
    seen: set[str] = set()
    for provider_id in order:
        available = is_available(provider_id, paxsenix_key)
        if not available:
            entries.append(
                {
                    "provider": provider_id,
                    "name": get_name(provider_id),
                    "available": False,
                    "synced": None,
                    "unsynced": None,
                    "quality": None,
                    "source": None,
                }
            )
            continue
        parsed_list = results.get(runnable_index[provider_id], [])
        if not parsed_list:
            entries.append(
                {
                    "provider": provider_id,
                    "name": get_name(provider_id),
                    "available": True,
                    "synced": None,
                    "unsynced": None,
                    "quality": None,
                    "source": None,
                }
            )
            continue
        for parsed in parsed_list:
            key = json.dumps(
                {"synced": parsed["synced"], "unsynced": parsed["unsynced"]},
                sort_keys=True,
                default=str,
            )
            if key in seen:
                continue
            seen.add(key)
            entries.append(
                {
                    "provider": provider_id,
                    "name": get_name(provider_id),
                    "available": True,
                    "synced": parsed["synced"],
                    "unsynced": parsed["unsynced"],
                    "quality": parsed["quality"],
                    "source": get_name(provider_id),
                }
            )
    return entries
