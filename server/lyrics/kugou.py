"""KuGou provider — port of ``KuGou.kt`` (ViMusic-derived).

Three-step flow:

1. search songs — ``mobileservice.kugou.com/api/v3/search/song``
   (``version=9108, plat=0, pagesize=8, showtype=0``,
   ``keyword="<title> - <artist>"``);
2. search lyrics by song hash, else by keyword —
   ``lyrics.kugou.com/search`` (``ver=1, man=yes, client=pc`` plus
   ``hash`` or ``keyword`` + ``duration`` in ms);
3. download — ``lyrics.kugou.com/download`` (``fmt=lrc, charset=utf8``),
   base64-decoded, then ``normalize()``: only ``[mm:ss.xx]`` lines survive,
   and head/tail runs of ``...]...: ...`` credit lines are trimmed.

Title/artist keywords are normalized exactly as in Kotlin (bracketed
parts stripped from titles; ``", "`` / ``" & "`` / ``"."`` / ``"和"``
folded in artists). Duration tolerance is 8 seconds.
"""

from __future__ import annotations

import base64
import re

from ._http import http_get_json

NAME = "Kugou"
ID = "kugou"

_PAGE_SIZE = 8
_HEAD_CUT_LIMIT = 30
_DURATION_TOLERANCE = 8

_ACCEPTED_RE = re.compile(r"\[(\d\d):(\d\d)\.(\d{2,3})\].*")
_BANNED_RE = re.compile(r".+].+[:：].+")


def _normalize_title(title: str) -> str:
    result = title
    for pattern in (
        r"\(.*\)",
        r"（.*）",
        r"「.*」",
        r"『.*』",
        r"<.*>",
        r"《.*》",
        r"〈.*〉",
        r"＜.*＞",
    ):
        result = re.sub(pattern, "", result)
    return result


def _normalize_artist(artist: str) -> str:
    result = (
        artist.replace(", ", "、").replace(" & ", "、").replace(".", "").replace("和", "、")
    )
    result = re.sub(r"\(.*\)", "", result)
    result = re.sub(r"（.*）", "", result)
    return result


def generate_keyword(title: str, artist: str) -> tuple[str, str]:
    return _normalize_title(title), _normalize_artist(artist)


def _normalize_lyrics(text: str) -> str:
    lines = [
        line for line in text.replace("&apos;", "'").splitlines()
        if _ACCEPTED_RE.fullmatch(line)
    ]
    head_cut_line = 0
    for i in range(min(_HEAD_CUT_LIMIT, len(lines) - 1), -1, -1):
        if _BANNED_RE.fullmatch(lines[i]):
            head_cut_line = i + 1
            break
    filtered = lines[head_cut_line:]
    tail_cut_line = 0
    last_index = len(lines) - 1
    for i in range(min(len(lines) - _HEAD_CUT_LIMIT, last_index), -1, -1):
        if _BANNED_RE.fullmatch(lines[last_index - i]):
            tail_cut_line = i + 1
            break
    final = filtered[: len(filtered) - tail_cut_line] if tail_cut_line else filtered
    return "\n".join(final)


def _search_songs(keyword: tuple[str, str]) -> dict:
    params = {
        "version": 9108,
        "plat": 0,
        "pagesize": _PAGE_SIZE,
        "showtype": 0,
        "keyword": f"{keyword[0]} - {keyword[1]}",
    }
    payload = http_get_json(
        "https://mobileservice.kugou.com/api/v3/search/song",
        params=params,
        timeout=15.0,
    )
    return payload if isinstance(payload, dict) else {}


def _search_lyrics_by_hash(song_hash: str) -> dict:
    payload = http_get_json(
        "https://lyrics.kugou.com/search",
        params={"ver": 1, "man": "yes", "client": "pc", "hash": song_hash},
        timeout=15.0,
    )
    return payload if isinstance(payload, dict) else {}


def _search_lyrics_by_keyword(keyword: tuple[str, str], duration: int) -> dict:
    params = {
        "ver": 1,
        "man": "yes",
        "client": "pc",
        "keyword": f"{keyword[0]} - {keyword[1]}",
    }
    if duration != -1:
        params["duration"] = duration * 1000
    payload = http_get_json(
        "https://lyrics.kugou.com/search", params=params, timeout=15.0
    )
    return payload if isinstance(payload, dict) else {}


def _download_lyrics(candidate_id, access_key: str) -> str:
    payload = http_get_json(
        "https://lyrics.kugou.com/download",
        params={
            "fmt": "lrc",
            "charset": "utf8",
            "client": "pc",
            "ver": 1,
            "id": candidate_id,
            "accesskey": access_key,
        },
        timeout=15.0,
    )
    content = payload.get("content", "") if isinstance(payload, dict) else ""
    return base64.b64decode(content).decode("utf-8", "replace")


def _candidates(payload: dict) -> list[dict]:
    candidates = payload.get("candidates") or []
    return [c for c in candidates if isinstance(c, dict)]


def _get_lyrics_candidate(keyword, duration) -> dict | None:
    songs = _search_songs(keyword).get("data", {}).get("info") or []
    for song in songs:
        if not isinstance(song, dict):
            continue
        song_duration = song.get("duration") or 0
        if duration == -1 or abs(song_duration - duration) <= _DURATION_TOLERANCE:
            candidate = next(iter(_candidates(_search_lyrics_by_hash(song.get("hash") or ""))), None)
            if candidate is not None:
                return candidate
    return next(iter(_candidates(_search_lyrics_by_keyword(keyword, duration))), None)


def _download_candidate(candidate: dict) -> str | None:
    try:
        return _normalize_lyrics(
            _download_lyrics(candidate.get("id"), candidate.get("accesskey") or "")
        )
    except Exception:
        return None


def get_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    duration = -1 if duration_seconds is None else int(duration_seconds)
    try:
        keyword = generate_keyword(title or "", artist or "")
        candidate = _get_lyrics_candidate(keyword, duration)
        if candidate is None:
            return None
        return _download_candidate(candidate)
    except Exception:
        return None


def get_all_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    duration = -1 if duration_seconds is None else int(duration_seconds)
    results = []
    try:
        keyword = generate_keyword(title or "", artist or "")
        songs = _search_songs(keyword).get("data", {}).get("info") or []
        for song in songs:
            if not isinstance(song, dict):
                continue
            if duration == -1 or abs((song.get("duration") or 0) - duration) <= _DURATION_TOLERANCE:
                candidate = next(
                    iter(_candidates(_search_lyrics_by_hash(song.get("hash") or ""))),
                    None,
                )
                if candidate is not None:
                    text = _download_candidate(candidate)
                    if text:
                        results.append(text)
        for candidate in _candidates(_search_lyrics_by_keyword(keyword, duration)):
            text = _download_candidate(candidate)
            if text:
                results.append(text)
    except Exception:
        pass
    return results
