import asyncio
import functools
import logging
import os
import re
import time
import uuid
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from yt_dlp.utils import DownloadError

from .. import debuglog, state
from ..core import (
    AUDIO_CACHE_DIR,
    STREAM_CLIENTS,
    StreamTarget,
    _is_permanent_failure,
    _prune_audio_cache,
    download_audio,
    find_cached_audio,
    forget_stream_url,
    resolve_stream_url,
)
from ..filters import DurationLimitExceeded
from ..sanitizers import sanitized

router = APIRouter(tags=["Stream"])
log = logging.getLogger(__name__)

CHAT_ID = os.environ.get("CHAT_ID")

# Any URL (googlevideo/videoplayback/...) must never reach the client.
_URL_PATTERN = re.compile(r"https?://\S+|videoplayback\?\S+", re.IGNORECASE)

MEDIA_TYPES = {
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".webm": "audio/webm",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
}

# Headers copied from the CDN response straight through to the browser.
# `Content-Length` / `Content-Range` are what make seeking (and the buffered
# part of the seek bar) work, so they are always forwarded when present.
# `Content-Type` is deliberately **not** forwarded: `_media_type` decides it,
# so an unhelpful `application/octet-stream` from the CDN can never reach the
# `<audio>` element.
_PASSTHROUGH = (
    "content-length",
    "content-range",
    "accept-ranges",
    "content-encoding",
    "content-md5",
    "etag",
    "last-modified",
    "cache-control",
)

# Upstream answers another player client may still fix (403 = CDN rejected the
# signed URL for this IP, 404 = this client's format is gone, ...).
_REJECTED_STATUS = {400, 401, 403, 404, 410, 429}

_CHUNK = 64 * 1024

_RANGE_RE = re.compile(r"bytes\s+(\d+)-(\d+|\*)/(\d+|\*)")


class _UpstreamRejected(Exception):
    """The CDN refused this stream URL — another player client may work."""


# ── Helpers ─────────────────────────────────────────────────────────────────

# pyrogram streams media in chunks of at most this size (`stream_media`).
_TG_CHUNK = 1024 * 1024


def _chat_id() -> int | str:
    """The channel as pyrogram likes it — numeric when the env says so."""
    try:
        return int(CHAT_ID)
    except (TypeError, ValueError):
        return CHAT_ID


# Background "cache this play" tasks — one entry per video while a download
# for it runs, so a burst of range requests cannot stack up yt-dlp passes.
_play_ensures: set[str] = set()

# Full-body writes still in flight: video id -> [Event, refcount].  A relay
# tee or a Telegram mirror announces itself while it fills the file, and the
# background caching task waits on that instead of fetching the same song a
# second time.  Two writers finishing seconds apart is what used to leave a
# `.m4a` and a byte-identical `.mp4` behind for one video id.
_body_writes: dict[str, list] = {}

# How long the background task waits for such a write before it assumes the
# relay was abandoned and downloads the song itself.  Exceeding it only
# costs a second fetch — the writers still de-duplicate on disk (first one
# to finish wins), so the cache never ends up with two copies of one song.
_BODY_WRITE_WAIT = 300


def _begin_body_write(vid_id: str) -> None:
    """Announce that a full-body write of *vid_id* into the cache started."""
    entry = _body_writes.get(vid_id)
    if entry is None:
        entry = _body_writes[vid_id] = [asyncio.Event(), 0]
    entry[1] += 1


def _end_body_write(vid_id: str) -> None:
    """Announce that a full-body write of *vid_id* finished (or was dropped)."""
    entry = _body_writes.get(vid_id)
    if entry is None:
        return
    entry[1] -= 1
    if entry[1] <= 0:
        _body_writes.pop(vid_id, None)
        entry[0].set()


async def _await_body_write(vid_id: str) -> None:
    """Wait until no full-body cache write for *vid_id* is running any more.

    Returns at once when nothing is in flight.  Bounded, so a stuck relay
    can only delay the background download — never hang it.
    """
    entry = _body_writes.get(vid_id)
    if entry is None:
        return
    try:
        await asyncio.wait_for(entry[0].wait(), timeout=_BODY_WRITE_WAIT)
    except asyncio.TimeoutError:
        log.debug("Timed out waiting for the cache write of %s", vid_id)


def _spawn_play_ensure(vid_id: str) -> None:
    """Start the background "cache this play" task.  No-op without Telegram.

    Called when a play is answered from a tier that fills the disk cache in
    the background (relay tee / Telegram mirror): the task registers its
    write *before* this runs, so the task waits for it instead of racing it.
    """
    if state.tg_client and CHAT_ID:
        asyncio.create_task(_ensure_tg_copy_for_play(vid_id))


async def _get_tg_msg_id(vid_id: str) -> int | None:
    """Return the Telegram message ID for a cached audio, or None."""
    raw = await state.rds.hget("vids", vid_id)
    return int(raw) if raw else None


async def _forget_tg_msg_id(vid_id: str) -> None:
    """Drop a stale `vids` entry so the normal path can re-upload later."""
    try:
        await state.rds.hdel("vids", vid_id)
        await state.rds.hdel("vid_sizes", vid_id)
    except Exception as exc:  # noqa: BLE001
        log.debug("Could not forget Telegram mapping for %s: %s", vid_id, exc)


async def _get_tg_size_record(vid_id: str) -> int | None:
    """Byte count recorded when this audio was uploaded, if we know it."""
    try:
        raw = await state.rds.hget("vid_sizes", vid_id)
        return int(raw) if raw else None
    except Exception as exc:  # noqa: BLE001
        log.debug("Could not read the size record for %s: %s", vid_id, exc)
        return None


async def _set_tg_size_record(vid_id: str, size: int) -> None:
    """Remember what Telegram holds so a later check can spot drift."""
    try:
        await state.rds.hset("vid_sizes", vid_id, size)
    except Exception as exc:  # noqa: BLE001
        log.debug("Could not record the size for %s: %s", vid_id, exc)


async def _upload_to_tg(vid_id: str, path: str):
    """
    Upload an already downloaded audio file to the Telegram channel.

    Retries on FloodWait by sleeping for the required duration.  The file is
    kept on disk — Telegram acts as a remote backup of the audio cache.
    """
    if not state.tg_client or not CHAT_ID:
        return

    while True:
        try:
            started = time.perf_counter()
            msg = await state.tg_client.send_document(
                _chat_id(),
                path,
                file_name=Path(path).name,
            )
            await state.rds.hset("vids", vid_id, msg.id)
            try:
                size = Path(path).stat().st_size
            except OSError:
                size = 0
            if size:
                await _set_tg_size_record(vid_id, size)
            log.info(
                "Uploaded %s to Telegram (msg %s, %s, %s)",
                vid_id,
                msg.id,
                debuglog.fmt_bytes(size),
                debuglog.fmt_ms((time.perf_counter() - started) * 1000),
            )
            break
        except Exception as exc:  # noqa: BLE001
            # FloodWaitError has a `value` attribute (seconds to wait)
            flood_wait = getattr(exc, "value", None)
            if flood_wait is not None:
                log.warning("FloodWait on %s — sleeping %ds", vid_id, flood_wait)
                await asyncio.sleep(flood_wait + 1)
                continue
            log.error("Failed to upload %s to Telegram: %s", vid_id, exc)
            break


async def _tg_copy_matches(vid_id: str, msg_id: int, path: Path | str) -> bool | None:
    """
    Whether the mapped Telegram copy still matches the file on disk.

    ``True`` when it is current, ``False`` when it must be replaced (the
    byte counts differ — e.g. a doubled copy written by an old race), and
    ``None`` when Telegram could not be asked right now, so the mapping is
    left alone and checked again on the next play.
    """
    try:
        local = Path(path).stat().st_size
    except OSError:
        return True  # nothing to compare against — leave the mapping alone
    recorded = await _get_tg_size_record(vid_id)
    if recorded is not None:
        return recorded == local
    # Legacy entry uploaded before sizes were recorded: ask Telegram once.
    try:
        message = await state.tg_client.get_messages(_chat_id(), msg_id)
    except Exception as exc:  # noqa: BLE001
        log.debug("Could not verify the Telegram copy of %s: %s", vid_id, exc)
        return None
    if message is None or getattr(message, "empty", False):
        return False
    document = getattr(message, "document", None)
    remote = int(getattr(document, "file_size", 0) or 0)
    if remote == local:
        await _set_tg_size_record(vid_id, local)
        return True
    log.warning(
        "Telegram copy of %s (msg %s) is %s but disk has %s — re-uploading",
        vid_id,
        msg_id,
        debuglog.fmt_bytes(remote),
        debuglog.fmt_bytes(local),
    )
    return False


async def _ensure_tg_copy(vid_id: str, path: Path | str) -> None:
    """
    Background: make sure the Telegram cache holds one good copy of this audio.

    Called wherever a complete file lands on disk (relay tee, full download,
    a disk-cache copy that predates the Telegram cache).  A mapping whose
    recorded byte count equals the file on disk is left alone; a mapping
    that drifted — a doubled copy from an old race, a message deleted behind
    our back — is dropped and replaced with the disk file, so the channel
    can never keep serving stale bytes.  No-ops without a configured client
    and while an upload for the same id is still running — the `state.py`
    upload events keep concurrent triggers from sending duplicates.
    """
    if not state.tg_client or not CHAT_ID:
        return
    stale_msg_id: int | None = None
    try:
        msg_id = await _get_tg_msg_id(vid_id)
        if msg_id:
            match = await _tg_copy_matches(vid_id, msg_id, path)
            if match is not False:
                # True = verified current; None = Telegram unreachable now.
                return
            stale_msg_id = msg_id
        running = state.get_upload_event(vid_id)
        if running:
            await running.wait()
            return
        event = asyncio.Event()
        state.set_upload_event(vid_id, event)
    except Exception as exc:  # noqa: BLE001
        log.warning("Telegram copy check failed for %s: %s", vid_id, exc)
        return
    try:
        if stale_msg_id is not None:
            try:
                await state.tg_client.delete_messages(_chat_id(), stale_msg_id)
                log.info(
                    "Deleted the stale Telegram message for %s (msg %s)",
                    vid_id,
                    stale_msg_id,
                )
            except Exception as exc:  # noqa: BLE001
                # The re-upload below re-maps the id either way; the old
                # bubble just lingers in the chat until someone prunes it.
                log.warning(
                    "Could not delete stale Telegram message %s for %s: %s",
                    stale_msg_id,
                    vid_id,
                    exc,
                )
        await _upload_to_tg(vid_id, str(path))
    finally:
        state.pop_upload_event(vid_id)
        event.set()


async def _ensure_tg_copy_for_play(vid_id: str) -> None:
    """
    Background after a play that found no file on disk.

    Songs used to reach the Telegram cache only when the player happened to
    read a relayed response down to the very last byte — a song that was
    skipped away was never cached at all.  This task closes that gap: it
    brings the file down in the background (once per song) and hands it to
    :func:`_ensure_tg_copy`, which uploads it or verifies the copy that is
    already mapped.  The in-flight set deduplicates the range-request burst
    a single play fires.  When a relay or a Telegram mirror is already
    writing the very same song to disk, the task waits for that write
    instead of fetching the track a second time in parallel — that race is
    what used to leave two files behind for one video id.  A mapped copy
    that already has a recorded size is left to the serve path, which
    re-checks it against the live message before answering — this task only
    fills the gaps (no mapping, or a mapping uploaded before sizes were
    tracked).
    """
    if not state.tg_client or not CHAT_ID or vid_id in _play_ensures:
        return
    _play_ensures.add(vid_id)
    try:
        msg_id = await _get_tg_msg_id(vid_id)
        if msg_id and await _get_tg_size_record(vid_id) is not None:
            # Already mapped with a recorded size — `_tg_media_response`
            # re-verifies it on the way out; nothing to do here.
            return
        path = find_cached_audio(vid_id)
        if path is None:
            # The play is being written to disk right now (relay tee or
            # Telegram mirror) — wait for it instead of downloading the very
            # same song a second time in parallel.
            await _await_body_write(vid_id)
            path = find_cached_audio(vid_id)
        if path is None:
            loop = asyncio.get_running_loop()
            try:
                path = Path(
                    await loop.run_in_executor(
                        state.executor, functools.partial(download_audio, vid_id)
                    )
                )
            except DurationLimitExceeded as exc:
                log.debug("Not caching %s in the background: %s", vid_id, exc)
                return
            except Exception as exc:  # noqa: BLE001
                log.warning("Background caching failed for %s: %s", vid_id, exc)
                return
        await _ensure_tg_copy(vid_id, path)
    except Exception as exc:  # noqa: BLE001
        log.warning("Background Telegram caching failed for %s: %s", vid_id, exc)
    finally:
        _play_ensures.discard(vid_id)


async def _tg_media_response(
    request: Request, vid_id: str, msg_id: int
) -> Response | None:
    """
    Serve the audio of a Telegram-cached message, range requests included.

    Returns ``None`` when the mapping is unusable — the message is gone, or
    its byte count no longer matches the size recorded at upload time (a
    doubled copy from an old race) — and forgets the mapping itself, so the
    relay below serves good bytes and the background ensure re-uploads a
    clean copy.  Every other failure raises, so a Telegram outage can be
    told apart from a stale entry.

    The bytes stream straight from the channel in pyrogram's 1 MiB chunks;
    when the response covers the whole file the chunks are also mirrored
    into the on-disk cache, so the next play never needs Telegram again.
    """
    message = await state.tg_client.get_messages(_chat_id(), msg_id)
    if message is None or getattr(message, "empty", False):
        log.warning(
            "Telegram message %s for %s is gone — forgetting it", msg_id, vid_id
        )
        await _forget_tg_msg_id(vid_id)
        return None
    document = getattr(message, "document", None)
    total = int(getattr(document, "file_size", 0) or 0)
    if document is None or total <= 0:
        await _forget_tg_msg_id(vid_id)
        return None

    # Serve the Telegram copy only when its byte count matches the size
    # recorded from a **verified** upload.  `vid_sizes` is written exclusively
    # from files the server itself fetched from the CDN — a relay tee that
    # matched the CDN's Content-Length, or a fresh yt-dlp download — so a
    # match proves this message holds that same audio.  A mismatch, or no
    # record at all (a mapping that predates size tracking), means the copy
    # cannot be proven good: an old download race wrote doubled files that
    # were then mirrored into the channel and served as ~2x-duration audio
    # with a silent tail.  Forget the mapping and let the relay below answer
    # with freshly fetched bytes; the background ensure re-uploads a verified
    # copy, so the next play is served from Telegram again.  This is also
    # what keeps the on-disk mirror (further down) from ever writing
    # unverified bytes back into the cache.
    recorded = await _get_tg_size_record(vid_id)
    if recorded != total:
        log.warning(
            "Telegram copy of %s is %s but the verified size is %s — forgetting it",
            vid_id,
            debuglog.fmt_bytes(total),
            debuglog.fmt_bytes(recorded) if recorded is not None else "unknown",
        )
        await _forget_tg_msg_id(vid_id)
        return None

    # ── Range header (single range; anything else = full body) ──────────
    start, end, status = 0, total - 1, 200
    range_header = (request.headers.get("range") or "").strip()
    if range_header:
        match = re.match(r"bytes=(\d*)-(\d*)$", range_header)
        if match:
            first, last = match.groups()
            if first:
                start = int(first)
                end = int(last) if last else total - 1
            elif last:
                # suffix range — the final N bytes
                start = max(0, total - int(last))
            if start >= total or start > end:
                return Response(
                    status_code=416,
                    headers={"Content-Range": f"bytes */{total}"},
                )
            end = min(end, total - 1)
            status = 206
    # Unrecognised range syntax → ignore it and send the whole body.

    file_name = getattr(document, "file_name", "") or ""
    media_type = MEDIA_TYPES.get(Path(file_name).suffix.lower(), "audio/mp4")
    whole = start == 0 and end == total - 1
    headers = {
        "Content-Length": str(end - start + 1),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
        # never let a reverse proxy buffer the stream
        "X-Accel-Buffering": "no",
    }
    if status == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"

    chunk_offset = start // _TG_CHUNK
    chunk_limit = end // _TG_CHUNK - chunk_offset + 1
    tmp_path = None
    if whole:
        try:
            AUDIO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            tmp_path = AUDIO_CACHE_DIR / f"{vid_id}.{uuid.uuid4().hex}.tg.part"
        except OSError:
            tmp_path = None  # mirror is a bonus — the stream must still run
    if tmp_path is not None:
        # Tell the background caching task a full copy is on its way, so it
        # waits for this mirror instead of downloading the song again.
        _begin_body_write(vid_id)

    async def pump():
        skip = start % _TG_CHUNK  # bytes to drop from the first chunk
        total_wanted = end - start + 1
        tee, tee_ok = _open_tee(tmp_path) if tmp_path else (None, False)
        written = 0
        try:
            async for chunk in state.tg_client.stream_media(
                message, offset=chunk_offset, limit=chunk_limit
            ):
                if skip:
                    if len(chunk) <= skip:
                        skip -= len(chunk)
                        continue
                    chunk = chunk[skip:]
                    skip = 0
                if len(chunk) > total_wanted - written:
                    chunk = chunk[: total_wanted - written]
                if tee is not None and tee_ok:
                    try:
                        tee.write(chunk)
                    except OSError:
                        tee_ok = False
                written += len(chunk)
                yield chunk
                if written >= total_wanted:
                    break
        except Exception as exc:  # noqa: BLE001
            # Mid-stream failures (FloodWait, dropped connection) cannot be
            # turned into an error status any more — log and stop cleanly.
            log.warning("Telegram stream broke for %s (msg %s): %s", vid_id, msg_id, exc)
        finally:
            try:
                if tee is not None:
                    try:
                        tee.flush()
                        tee.close()
                    except OSError:
                        tee_ok = False
                    if tee_ok and written == total and tmp_path is not None:
                        final = AUDIO_CACHE_DIR / f"{vid_id}.m4a"
                        if find_cached_audio(vid_id) is not None:
                            # Another writer (relay tee, background download)
                            # finished this song while we streamed it — keep
                            # its file instead of leaving two copies of one
                            # track in the cache.
                            tmp_path.unlink(missing_ok=True)
                            log.debug(
                                "Discarded a duplicate Telegram mirror of %s",
                                vid_id,
                            )
                        else:
                            try:
                                os.replace(tmp_path, final)
                                _prune_audio_cache()
                                log.info(
                                    "Mirrored %s from Telegram into the disk cache",
                                    vid_id,
                                )
                            except OSError as exc:
                                log.warning(
                                    "Could not mirror %s from Telegram: %s",
                                    vid_id,
                                    exc,
                                )
                                tmp_path.unlink(missing_ok=True)
                    elif tmp_path is not None:
                        tmp_path.unlink(missing_ok=True)
            finally:
                if tmp_path is not None:
                    _end_body_write(vid_id)

    return StreamingResponse(pump(), status_code=status, headers=headers, media_type=media_type)


def _safe_detail(exc: Exception) -> str:
    """
    Turn a yt-dlp failure into a client facing message.

    The full error is logged server side, but streaming URLs (googlevideo,
    videoplayback, ...) are stripped from anything sent back to the browser.
    """
    text = " ".join(str(exc).split())
    text = _URL_PATTERN.sub("[streaming url removed]", text).strip()
    return text[:300] or "unknown error"


def _media_type(headers: httpx.Headers, url: str) -> str:
    """Audio content type for a proxied response (from header, else suffix)."""
    declared = (headers.get("content-type") or "").split(";")[0].strip()
    if declared.startswith(("audio/", "video/")):
        return declared
    suffix = Path(url.split("?", 1)[0]).suffix.lower()
    return MEDIA_TYPES.get(suffix, "audio/mp4")


def _open_tee(tmp_path: Path):
    """Open the temporary cache file of a relay, or ``(None, False)``."""
    try:
        return open(tmp_path, "wb"), True
    except OSError:
        return None, False


def _is_whole_body(status_code: int, range_header: str | None, headers) -> bool:
    """
    True when the upstream response is (or will be) the complete audio file.

    Only then is it worth teeing into the on-disk cache: a partial answer
    (a seek that landed in the middle of the track) must never be stored as
    if it were the whole song.
    """
    if (headers.get("content-length") or "").strip() == "0":
        return False
    if status_code == 200:
        # the origin ignored the Range header and sent everything
        return True
    if status_code != 206 or not range_header:
        return False
    match = _RANGE_RE.match(headers.get("content-range") or "")
    if not match:
        return False
    start, end, total = match.groups()
    if start != "0":
        return False
    return total == "*" or (end != "*" and int(end) + 1 == int(total))


async def _proxy_audio(
    request: Request, target: StreamTarget, vid_id: str
) -> StreamingResponse | Response:
    """
    Relay the CDN response to the browser, range requests included.

    The first byte arrives as soon as the CDN has it instead of after the
    whole track has been written to disk, which is what made playback feel
    slow.  The remote URL itself still never leaves the server.

    While a *complete* body passes through it is also written into the audio
    cache, so the next play of that track is served from disk.

    A ``416`` from the CDN is not passed back to the player.  Some resolved
    URLs (formats whose own ``range=`` query parameter collides with the
    client ``Range`` header) answer ``416`` to an offset the player will
    never give up on, and the client reports it as a *Source error*.  In
    that case the body is fetched again without the ``Range`` header and the
    requested offset is sliced off in flight — the client gets a normal
    ``206`` from ``Content-Range``, the bytes start at the right place and
    the complete body still lands in the audio cache.
    """
    upstream_headers = dict(target.headers or {})
    upstream_headers.pop("Host", None)
    upstream_headers.pop("host", None)
    range_header = request.headers.get("range")
    if range_header:
        upstream_headers["Range"] = range_header

    client = httpx.AsyncClient(
        follow_redirects=True,
        timeout=httpx.Timeout(20.0, read=120.0),
    )
    upstream = await client.send(
        client.build_request("GET", target.url, headers=upstream_headers),
        stream=True,
    )

    # Try to rescue a CDN 416 by fetching the body without a Range header
    # and skipping to the requested offset while streaming.  A first-byte
    # offset (``bytes=0-``) is simply refetched without the header, which
    # turns the response into a normal 200 whole-body.
    slice_start = 0
    if upstream.status_code == 416 and range_header:
        match = re.match(r"\s*bytes=(\d+)-", range_header.strip())
        if match:
            slice_start = int(match.group(1))
            await upstream.aclose()
            upstream_headers.pop("Range", None)
            upstream = await client.send(
                client.build_request("GET", target.url, headers=upstream_headers),
                stream=True,
            )
            log.info(
                "CDN answered 416 for %s (range=%s, client=%s) — refetching without it",
                vid_id,
                range_header,
                target.client,
            )

    if upstream.status_code in _REJECTED_STATUS:
        status = upstream.status_code
        await upstream.aclose()
        await client.aclose()
        raise _UpstreamRejected(f"upstream responded with {status}")

    if slice_start:
        # The rescue reopen succeeded or not — a now-rejected status is the
        # same "another player client may fix this" situation as before.
        if upstream.status_code >= 400:
            status = upstream.status_code
            await upstream.aclose()
            await client.aclose()
            raise _UpstreamRejected(f"upstream responded with {status}")
        full_length = (upstream.headers.get("content-length") or "").strip()
        total = int(full_length) if full_length.isdigit() else None
        if total is not None and slice_start >= total:
            # The requested offset is beyond the real end of the stream: no
            # byte can be served for it.  Answer the client's bookkeeping
            # with the honest 416 + Content-Range instead of an empty body.
            log.warning(
                "Range start %d is past the end of %s (%d bytes)",
                slice_start,
                vid_id,
                total,
            )
            await upstream.aclose()
            await client.aclose()
            return Response(416, headers={"Content-Range": f"bytes */{total}"})

    headers = {
        key: value
        for key, value in upstream.headers.items()
        if key in _PASSTHROUGH
    }
    headers.setdefault("accept-ranges", "bytes")
    headers["X-Accel-Buffering"] = "no"

    status_code = upstream.status_code
    if slice_start:
        # Serve the refetched whole body as a range response so the client's
        # offsets keep matching its own bookkeeping.
        status_code = 206
        if total is not None:
            headers["content-length"] = str(total - slice_start)
            headers["content-range"] = f"bytes {slice_start}-{total - 1}/{total}"
        else:
            # Without a known total a Content-Range cannot be trusted — drop
            # the stale full-body length too, rather than underline wrong.
            headers.pop("content-length", None)

    tee_path: Path | None = None
    tmp_path: Path | None = None
    # The 416 rescue re-downloaded the *complete* body, so a tee is always
    # worth it there; `_is_whole_body(downstream_status_code=200)` covers it.
    if slice_start or _is_whole_body(upstream.status_code, range_header, upstream.headers):
        AUDIO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tmp_path = AUDIO_CACHE_DIR / f"{vid_id}.{uuid.uuid4().hex}.part"
        tee_path = AUDIO_CACHE_DIR / f"{vid_id}.m4a"
        # Announce the write before returning: the background caching task is
        # spawned as soon as this response goes out and must wait for these
        # bytes instead of downloading the same song in parallel.
        _begin_body_write(vid_id)

    written = 0

    async def pump():
        nonlocal written
        # opened lazily: if the response is never iterated nothing is left
        # behind on disk, and it is closed by the `finally` below either way
        handle = _open_tee(tmp_path)[0] if tmp_path else None
        tee_ok = handle is not None
        tee_size = 0
        skip = slice_start
        try:
            async for chunk in upstream.aiter_raw(_CHUNK):
                if skip:
                    if len(chunk) <= skip:
                        skip -= len(chunk)
                        continue
                    chunk = chunk[skip:]
                    skip = 0
                if handle is not None and tee_ok:
                    try:
                        handle.write(chunk)
                        tee_size += len(chunk)
                    except OSError:
                        # disk trouble must never break playback
                        tee_ok = False
                written += len(chunk)
                yield chunk
        finally:
            try:
                if handle is not None:
                    try:
                        handle.flush()
                        handle.close()
                    except (OSError, ValueError):
                        tee_ok = False
                    expected = int(upstream.headers.get("content-length") or 0)
                    # `written` may be short when the client asked for a mid-file
                    # offset, so completeness is measured against what reached the
                    # tee (the full upstream body) instead.
                    if (
                        tee_ok
                        and expected
                        and tee_size == expected
                        and tmp_path
                        and tee_path
                    ):
                        if find_cached_audio(vid_id) is not None:
                            # Another writer finished this song while we
                            # streamed it — keep its file instead of leaving
                            # two copies of one track in the cache.
                            tmp_path.unlink(missing_ok=True)
                            log.debug(
                                "Discarded a duplicate relay tee for %s", vid_id
                            )
                        else:
                            try:
                                os.replace(tmp_path, tee_path)
                            except OSError as exc:
                                log.warning(
                                    "Could not cache the relay of %s: %s", vid_id, exc
                                )
                                tmp_path.unlink(missing_ok=True)
                            else:
                                _prune_audio_cache()
                                # Background: the relay only ever runs when the disk
                                # cache was cold — once the file is complete, give the
                                # Telegram cache its copy too.
                                asyncio.create_task(_ensure_tg_copy(vid_id, tee_path))
                                log.info(
                                    "Cached streamed audio for %s (%d bytes)",
                                    vid_id,
                                    tee_size,
                                )
                    elif tmp_path:
                        tmp_path.unlink(missing_ok=True)
            finally:
                if tmp_path is not None:
                    _end_body_write(vid_id)
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        pump(),
        status_code=status_code,
        headers=headers,
        media_type=_media_type(upstream.headers, target.url),
    )


def _size_detail(path: Path) -> str:
    """``3.58 MiB`` for a tier log line — empty when the file cannot be statted."""
    try:
        return debuglog.fmt_bytes(path.stat().st_size)
    except OSError:
        return ""


# ── Stream endpoint ─────────────────────────────────────────────────────────


@router.get(
    "/stream/status",
    summary="Audio Cache Status",
    response_description="Whether the audio of the video is already on disk",
)
@sanitized
async def stream_status(
    vidId: str = Query(..., description="YouTube video ID to check"),
):
    """
    Whether the audio of a video is already in the server side audio cache.

    The client polls this while the song is still streaming: as soon as the
    relay has finished writing the file, a download can read it straight from
    disk instead of opening a second live stream next to the one the player
    is holding open.

    Deliberately not cached — the whole point of the answer is how fresh it
    is — and it only stats a file, so it never touches yt-dlp or the CDN.
    """
    return {"cached": bool(find_cached_audio(vidId))}


@router.get(
    "/stream",
    summary="Stream Audio",
    response_description="Audio file buffered on the server for the given video",
)
async def stream_audio(
    request: Request,
    vidId: str = Query(..., description="YouTube video ID to stream"),
):
    """
    Serve the audio of a video, always through this server.

    Priority:

    1. **local audio cache** — the track was already downloaded, served with a
       ``FileResponse`` (HTTP range requests included);
    2. **Telegram channel cache** — the ``vids`` Redis hash holds a message id
       for this video; the message is streamed chunk by chunk straight from
       the channel (range requests included) and mirrored back into the
       on-disk cache on a full pass;
    3. **relayed stream** — yt-dlp resolves the CDN URL (cached in memory with
       its expiry) and the bytes are forwarded chunk by chunk, so playback
       starts immediately and seeking works while the rest is still coming;
       complete relays are written into the audio cache on the way out;
    4. **full yt-dlp download** — used when the CDN rejects every relayed
       attempt, the file is then buffered on disk first.

    The raw googlevideo URL is never handed back to the client.

    Telegram only ever answers when a bot token and a pyrogram client are
    configured (``state.tg_client``) — otherwise the lookup and the stream
    are skipped entirely and nothing changes for the client.  Every
    complete file the server holds is uploaded in the background, so the
    ``vids`` hash converges over time.
    """
    started = time.perf_counter()
    cached = find_cached_audio(vidId)
    if cached:
        try:
            response = _audio_response(cached, vidId)
        except OSError:
            # The audio cache only keeps its newest files, so this one may
            # have been pruned between the lookup and the open.  Falling
            # through relays it again instead of letting a broken response
            # reach the browser as a headerless 500 — which it reports as a
            # CORS error.
            log.warning("Cached audio for %s disappeared before serving", vidId)
        else:
            # Older copies may predate the Telegram cache — fill it in the
            # background without touching the response.  This also verifies
            # that an already-mapped copy still matches the file byte for
            # byte, and re-uploads it when it does not.
            asyncio.create_task(_ensure_tg_copy(vidId, cached))
            debuglog.tier(vidId, "disk-cache", started, _size_detail(cached), log)
            return response

    # Every play counts: a song that is skipped away never completes a relay
    # pass, so it is cached in the background.  The task is spawned once the
    # tier that answers is known (below), *after* that tier announced its own
    # write — otherwise the download and the write would run in parallel and
    # store the same song twice.  No-op without a configured Telegram client.

    # 2) Telegram channel — the `vids` hash maps this id to a message id
    if state.tg_client and CHAT_ID:
        try:
            tg_msg_id = await _get_tg_msg_id(vidId)
        except Exception as exc:  # noqa: BLE001
            # Redis trouble must never break playback — skip the TG tier.
            log.warning("Telegram lookup failed for %s: %s", vidId, exc)
            tg_msg_id = None
        if tg_msg_id:
            try:
                tg_response = await _tg_media_response(request, vidId, tg_msg_id)
            except Exception as exc:  # noqa: BLE001
                # Transient failure (network, FloodWait) — keep the mapping,
                # the next request may well succeed.
                log.warning(
                    "Telegram stream failed for %s (msg %s): %s", vidId, tg_msg_id, exc
                )
            else:
                if tg_response is not None:
                    debuglog.tier(
                        vidId, "telegram", started, f"msg {tg_msg_id}", log
                    )
                    _spawn_play_ensure(vidId)
                    return tg_response
                # Unusable mapping — `_tg_media_response` already forgot it;
                # the relay below answers with the good bytes.

    loop = asyncio.get_running_loop()
    skip: set = set()
    # Player clients whose *extraction* failed above — a full download would
    # only repeat the very same yt-dlp extraction, so they are skipped there
    # (a client the CDN merely rejected while *relaying* is still worth a
    # real download attempt: yt-dlp fetches with its own headers).
    extract_failed: set = set()

    # 3) relay through the server
    while len(skip) <= len(STREAM_CLIENTS):
        try:
            with debuglog.timed(f"resolve_stream_url {vidId}", log):
                target = await loop.run_in_executor(
                    state.executor,
                    functools.partial(
                        resolve_stream_url, vidId, skip, extract_failed
                    ),
                )
        except DurationLimitExceeded as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            log.warning("Stream resolution failed for %s: %s", vidId, exc)
            if _is_permanent_failure(exc):
                # Every player client already reported the track itself as
                # unavailable — the full download path would only repeat the
                # very same yt-dlp attempts, so fail right away.
                raise HTTPException(
                    status_code=502,
                    detail=f"Failed to download audio: {_safe_detail(exc)}",
                ) from exc
            break

        try:
            response = await _proxy_audio(request, target, vidId)
            debuglog.tier(
                vidId, "relay", started, f"client {target.client or 'default'}", log
            )
            _spawn_play_ensure(vidId)
            return response
        except _UpstreamRejected as exc:
            log.warning(
                "CDN rejected the %s stream for %s: %s",
                target.client,
                vidId,
                exc,
            )
            forget_stream_url(vidId)
            skip.add(target.client)
        except Exception as exc:  # noqa: BLE001
            # The connection to the CDN died before a single byte was sent
            # (network blip, URL expired while connecting, socket reset).
            # Nothing is on the wire yet, so move to the next player client
            # and let the full download below be the last resort — letting
            # this escape used to reach the browser as a headerless 500,
            # which it reported as a CORS error.
            log.warning(
                "Relay failed for %s via %s: %s",
                vidId,
                target.client,
                exc,
            )
            skip.add(target.client)

    # 4) fall back to buffering the whole file on the server
    try:
        path = await loop.run_in_executor(
            state.executor,
            functools.partial(download_audio, vidId, extract_failed),
        )
    except DurationLimitExceeded as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=500,
            detail="yt-dlp is not installed or not found on PATH",
        ) from exc
    except DownloadError as exc:
        log.warning("yt-dlp failed for %s: %s", vidId, exc)
        raise HTTPException(
            status_code=502,
            detail=f"Failed to download audio: {_safe_detail(exc)}",
        ) from exc
    except Exception as exc:
        log.warning("Audio download failed for %s: %s", vidId, exc)
        raise HTTPException(
            status_code=502,
            detail=f"Failed to download audio: {_safe_detail(exc)}",
        ) from exc

    debuglog.tier(vidId, "download", started, _size_detail(Path(path)), log)

    # Background: keep a Telegram copy of the freshly downloaded audio
    asyncio.create_task(_ensure_tg_copy(vidId, path))

    try:
        return _audio_response(path, vidId)
    except OSError as exc:
        raise HTTPException(
            status_code=502,
            detail="The downloaded audio could not be read from disk",
        ) from exc


def _audio_response(path: Path | str, vid_id: str) -> FileResponse:
    """
    Serve a locally downloaded audio file.

    ``FileResponse`` answers HTTP range requests (206), which is what lets the
    browser seek inside the track.
    """
    path = Path(path)
    media_type = MEDIA_TYPES.get(path.suffix.lower(), "audio/mp4")
    # Stat up front and hand the result over: on its own ``FileResponse``
    # stats *after* the route returned, and a file that vanished in between
    # (pruned, rewritten by a download) used to raise a ``RuntimeError``
    # before the response headers — a headerless 500 that the browser
    # reports as a CORS error.  Raising here lets the caller fall back to
    # the relay instead.
    return FileResponse(
        path,
        stat_result=path.stat(),
        media_type=media_type,
        headers={
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=3600",
            "X-Accel-Buffering": "no",
        },
    )
