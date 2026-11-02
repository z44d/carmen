"""Lyric text parsing — a port of ``LyricsUtils`` (Android) minus romanization.

Romanization generation (Kuromoji, ICU transliteration, the katakana and
hangul maps) is deliberately NOT ported: the server never generates
romanization. Provider-supplied romanization/translation fields are carried
through, never generated — and a provider romanization is only surfaced
when it differs from the original line (case-insensitive) and is not
Arabic-claimed (language tag starting with ``ar``), mirroring
``LyricsUtils.shouldUseProvidedRomanization`` with romanization enabled.

Public entry point: :func:`parse_lyrics`, which returns::

    {"synced": [line, ...] | None, "unsynced": str | None, "quality": 0|1|2}

Each synced line is::

    {"timeMs": int, "endTimeMs": int, "text": str,
     "words": [{"text", "startMs", "endMs", "isBackground"}] (optional),
     "translation": str (optional), "romanizedText": str (optional),
     "romanizedWords": [str] (optional), "isInstrumental": bool (optional),
     "agent": str (optional), "durationMs": int (optional)}

``quality`` follows the Android ranking: 2 = word-synced, 1 = line-synced
(including TTML), 0 = plain text.
"""

from __future__ import annotations

import re

from ._qrc import has_word_timings as _qrc_has_word_timings
from ._qrc import is_qrc, parse_qrc
from ._ttml import parse_ttml as _parse_ttml_document

_LINE_RE = re.compile(r"((\[\d{1,3}:\d{2}(?:[.:]\d{2,3})?\]\s*)+)(.*)")
_TIME_RE = re.compile(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{2,3}))?\]")
_WHITESPACE_RE = re.compile(r"\s+")
_ENHANCED_WORD_TIME_RE = re.compile(r"<(\d{1,3}):(\d{2})(?:[.:](\d{2,3}))?>")
_INLINE_MS_TIME_RE = re.compile(r"<\d{1,8}(?:,\d{1,8})?>")
_YRC_LINE_RE = re.compile(r"\[(\d{1,8}),\d{1,8}\](.*)")
_YRC_WORD_TIME_RE = re.compile(r"\(\d{1,8},\d{1,8}(?:,\d{1,8})?\)")
_TTML_SPAN_RE = re.compile(r"<span\b[^>]*>", re.IGNORECASE | re.DOTALL)
_TTML_BEGIN_ATTR_RE = re.compile(r"\bbegin\s*=", re.IGNORECASE)
_TTML_END_ATTR_RE = re.compile(r"\b(?:end|dur)\s*=", re.IGNORECASE)
_INVISIBLE_CHARS_RE = re.compile("[\u200b\u200c\u200d\u2060\u00ad]")
_NBSP = "\u00a0"

_DEFAULT_ENHANCED_WORD_DURATION_MS = 1000
_INSTRUMENTAL_GAP_THRESHOLD_MS = 5000
_INSTRUMENTAL_INTRO_START_MS = 1000
_INSTRUMENTAL_OUTRO_VOCAL_TAIL_MS = 2500

_LYRICS_NOT_FOUND = "LYRICS_NOT_FOUND"


# ── Normalization / detection ──────────────────────────────────────────────


def normalize_lyrics_text(lyrics: str) -> str:
    raw = _INVISIBLE_CHARS_RE.sub("", lyrics.replace("\ufeff", "")).strip()
    unwrapped = _strip_code_fence(raw)
    if _is_escaped_ttml(unwrapped):
        normalized = (
            unwrapped.replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", '"')
            .replace("&#39;", "'")
            .replace("&apos;", "'")
        )
    else:
        normalized = unwrapped
    return normalized.strip()


def _strip_code_fence(lyrics: str) -> str:
    if not lyrics.startswith("```"):
        return lyrics
    lines = lyrics.splitlines()
    if len(lines) <= 1:
        return lyrics
    remaining = lines[1:]
    if remaining and remaining[-1].strip() == "```":
        remaining = remaining[:-1]
    return "\n".join(remaining).strip()


def _is_escaped_ttml(lyrics: str) -> bool:
    trimmed = lyrics.lstrip()
    lowered = trimmed.lower()
    return lowered.startswith("&lt;tt") or "&lt;tt" in lowered or (
        "http://www.w3.org/ns/ttml" in lowered and "&lt;" in lowered
    )


def is_ttml(lyrics: str) -> bool:
    trimmed = normalize_lyrics_text(lyrics)
    if not trimmed.startswith("<"):
        return False
    lowered = trimmed.lower()
    return "<tt" in lowered or "http://www.w3.org/ns/ttml" in lowered


def is_line_synced_lrc(lyrics: str) -> bool:
    if is_qrc(normalize_lyrics_text(lyrics)):
        return True
    return any(
        _LINE_RE.fullmatch(line.strip()) is not None
        or _YRC_LINE_RE.fullmatch(line.strip()) is not None
        for line in lyrics.splitlines()
    )


def has_word_synced_lyrics(lyrics: str) -> bool:
    normalized = normalize_lyrics_text(lyrics)
    if is_qrc(normalized):
        return _qrc_has_word_timings(normalized)
    if is_ttml(normalized):
        return any(
            _TTML_BEGIN_ATTR_RE.search(m.group(0)) is not None
            and _TTML_END_ATTR_RE.search(m.group(0)) is not None
            for m in _TTML_SPAN_RE.finditer(normalized)
        )
    return any(_has_enhanced_lrc_word_timings(line) for line in normalized.splitlines())


def _has_enhanced_lrc_word_timings(line: str) -> bool:
    match = _LINE_RE.fullmatch(line.strip())
    if match is None:
        return False
    content = match.group(3)
    timing_matches = list(_ENHANCED_WORD_TIME_RE.finditer(content))
    for index, timing_match in enumerate(timing_matches):
        text_start = timing_match.end()
        text_end = (
            timing_matches[index + 1].start()
            if index + 1 < len(timing_matches)
            else len(content)
        )
        if text_start < text_end and content[text_start:text_end]:
            return True
    return False


def display_lyrics_text(lyrics: str) -> str:
    raw = normalize_lyrics_text(lyrics)
    if not raw or raw == _LYRICS_NOT_FOUND:
        return ""
    if is_ttml(raw):
        try:
            visible = [line["text"] for line in _parse_ttml_lines(raw)]
        except Exception:
            visible = []
    elif is_line_synced_lrc(raw):
        try:
            visible = [line["text"] for line in _parse_synced_entries(raw)]
        except Exception:
            visible = []
    elif raw.startswith("<"):
        visible = []
    else:
        visible = [_clean_inline_word_timing_text(line) for line in raw.splitlines()]
    return "\n".join(
        _WHITESPACE_RE.sub(" ", line).strip()
        for line in visible
        if _WHITESPACE_RE.sub(" ", line).strip()
    )


def has_meaningful_lyrics_content(lyrics: str) -> bool:
    return bool(display_lyrics_text(lyrics))


def lyrics_or_not_found(lyrics: str) -> str | None:
    """Return the normalized text, or ``None`` when it holds no lyrics."""
    normalized = normalize_lyrics_text(lyrics)
    return normalized if has_meaningful_lyrics_content(normalized) else None


# ── Entry point ────────────────────────────────────────────────────────────


def parse_lyrics(raw_text: str | None, duration_seconds: int | None = None):
    """Parse raw provider lyrics into the extended line shape.

    Returns ``{"synced": [... ] | None, "unsynced": str | None,
    "quality": 0|1|2}``. Empty/meaningless input yields ``synced=None`` and
    ``unsynced=None`` (the ``lyricsOrNotFound`` semantics). When synced
    lines exist, ``unsynced`` is their visible text joined with newlines so
    old clients that only read ``unsynced`` keep working.
    """
    if not isinstance(raw_text, str):
        return {"synced": None, "unsynced": None, "quality": 0}
    normalized = normalize_lyrics_text(raw_text)
    if not has_meaningful_lyrics_content(normalized):
        return {"synced": None, "unsynced": None, "quality": 0}

    if is_ttml(normalized):
        entries = _parse_ttml_lines(normalized)
        if not entries:
            return {"synced": None, "unsynced": None, "quality": 0}
        lines = [_entry_to_line(entry) for entry in entries]
        lines = _finalize_lines(lines, duration_seconds)
        quality = 2 if any(line.get("words") for line in lines) else 1
        return {
            "synced": lines,
            "unsynced": _joined_text(lines),
            "quality": quality,
        }

    if is_line_synced_lrc(normalized):
        entries = _parse_synced_entries(normalized)
        if not entries:
            return {"synced": None, "unsynced": None, "quality": 0}
        lines = [_entry_to_line(entry) for entry in entries]
        lines = _finalize_lines(lines, duration_seconds)
        quality = 2 if any(line.get("words") for line in lines) else 1
        return {
            "synced": lines,
            "unsynced": _joined_text(lines),
            "quality": quality,
        }

    if normalized.startswith("<"):
        return {"synced": None, "unsynced": None, "quality": 0}
    unsynced = display_lyrics_text(normalized)
    if not unsynced:
        return {"synced": None, "unsynced": None, "quality": 0}
    return {"synced": None, "unsynced": unsynced, "quality": 0}


def _joined_text(lines: list[dict]) -> str | None:
    text = "\n".join(line["text"] for line in lines if line["text"].strip())
    return text or None


def _finalize_lines(lines: list[dict], duration_seconds: int | None) -> list[dict]:
    """Sort, fill end times, and insert instrumental breaks."""
    lines = sorted(lines, key=lambda line: line["timeMs"])
    for index, line in enumerate(lines):
        following = lines[index + 1] if index + 1 < len(lines) else None
        if line["endTimeMs"] <= line["timeMs"]:
            line["endTimeMs"] = (
                following["timeMs"] if following else line["timeMs"] + 4000
            )
    if duration_seconds:
        lines = insert_instrumental_breaks(lines, duration_seconds * 1000)
        lines = sorted(lines, key=lambda line: line["timeMs"])
    return lines


# ── TTML ───────────────────────────────────────────────────────────────────


def _parse_ttml_lines(normalized: str) -> list[dict]:
    """TTMLParser.parseTTML mapped onto LyricsEntry-shaped dicts."""
    parsed = _parse_ttml_document(normalized)
    entries = []
    for line in parsed:
        words = [
            {
                "text": word["text"],
                "start": word["start"],
                "end": word["end"],
                "isBackground": word["isBackground"],
            }
            for word in line["words"]
            if word["text"]
        ]
        entries.append(
            {
                "time": round(line["start"] * 1000.0),
                "endMs": round(line["end"] * 1000.0),
                "text": line["text"],
                "words": words or None,
                "agent": line["agent"],
                "romanizedText": line["providerRomanizedText"],
                "romanizedWords": line["providerRomanizedWords"],
                "romanizedLanguage": line["providerRomanizedLanguage"],
                "translation": line["providerTranslationText"],
            }
        )
    entries.sort(key=lambda entry: entry["time"])
    return entries


# ── LRC / QRC ──────────────────────────────────────────────────────────────


def _parse_synced_entries(normalized: str) -> list[dict]:
    """LyricsUtils.parseLyrics (the LRC/QRC branch, without romanization)."""
    if is_qrc(normalized):
        entries = []
        for line in parse_qrc(normalized):
            words = [
                {
                    "text": word["text"],
                    "start": word["start"],
                    "end": word["end"],
                    "isBackground": False,
                }
                for word in line["words"]
            ]
            entries.append(
                {
                    "time": round(line["start"] * 1000.0),
                    "text": line["text"],
                    "words": words or None,
                    "agent": line["agent"],
                    "durationMs": max(
                        0, round((line["end"] - line["start"]) * 1000.0)
                    ),
                }
            )
        return entries

    lines = normalized.splitlines()
    result: list[dict] = []
    for index, line in enumerate(lines):
        line_start_ms = _first_line_timestamp_ms(line)
        next_line_start_ms = _find_next_line_start_ms(lines, index, line_start_ms)
        entries = _parse_enhanced_lrc_line(line, next_line_start_ms)
        if entries is None:
            entries = _parse_line_synced_lrc_line(line)
        if entries is None:
            entries = _parse_milliseconds_synced_line(line)
        if entries is not None:
            result.extend(entries)
    return _merge_line_synced_translations(result)


def _parse_line_synced_lrc_line(line: str) -> list[dict] | None:
    if not line:
        return None
    match = _LINE_RE.fullmatch(line.strip())
    if match is None:
        return None
    times = match.group(1)
    text = _clean_inline_word_timing_text(match.group(3))
    entries = []
    for time_match in _TIME_RE.finditer(times):
        time_ms = _lrc_timestamp_ms(time_match)
        if time_ms is None:
            continue
        entries.append({"time": time_ms, "text": text})
    return entries or None


def _parse_enhanced_lrc_line(
    line: str, next_line_start_ms: int | None
) -> list[dict] | None:
    match = _LINE_RE.fullmatch(line.strip())
    if match is None:
        return None
    raw_content = match.group(3)
    timing_matches = list(_ENHANCED_WORD_TIME_RE.finditer(raw_content))
    if not timing_matches:
        return None

    raw_words: list[dict] = []
    for index, timing_match in enumerate(timing_matches):
        text_start = timing_match.end()
        text_end = (
            timing_matches[index + 1].start()
            if index + 1 < len(timing_matches)
            else len(raw_content)
        )
        text = raw_content[text_start:text_end]
        if index == 0 and timing_match.start() > 0:
            text = raw_content[: timing_match.start()] + text
        if not text:
            continue
        start_ms = _lrc_timestamp_ms(timing_match)
        if start_ms is None:
            continue
        end_ms = None
        if index + 1 < len(timing_matches):
            end_ms = _lrc_timestamp_ms(timing_matches[index + 1])
        if not text.strip() and raw_words:
            raw_words[-1] = {**raw_words[-1], "text": raw_words[-1]["text"] + text}
        else:
            raw_words.append({"text": text, "startMs": start_ms, "endMs": end_ms})
    if not raw_words:
        return None

    line_start_times = [
        ms for m in _TIME_RE.finditer(match.group(1)) if (ms := _lrc_timestamp_ms(m)) is not None
    ]
    if not line_start_times:
        return None
    base_line_start_ms = line_start_times[0]
    visible_text = _clean_inline_word_timing_text(raw_content)
    if not visible_text:
        return None

    entries = []
    for index, line_start_ms in enumerate(line_start_times):
        offset_ms = line_start_ms - base_line_start_ms
        following_line_start_ms = (
            line_start_times[index + 1]
            if index + 1 < len(line_start_times)
            else next_line_start_ms
        )
        words = []
        for raw_word in raw_words:
            word_start_ms = max(0, raw_word["startMs"] + offset_ms)
            if raw_word["endMs"] is not None:
                word_end_ms = raw_word["endMs"] + offset_ms
            elif following_line_start_ms is not None:
                word_end_ms = following_line_start_ms
            else:
                word_end_ms = word_start_ms + _DEFAULT_ENHANCED_WORD_DURATION_MS
            word_end_ms = max(word_end_ms, word_start_ms + 1)
            words.append(
                {
                    "text": raw_word["text"],
                    "start": word_start_ms / 1000.0,
                    "end": word_end_ms / 1000.0,
                    "isBackground": False,
                }
            )
        line_end_ms = max(round(word["end"] * 1000.0) for word in words)
        entries.append(
            {
                "time": line_start_ms,
                "text": visible_text,
                "words": words,
                "durationMs": max(1, line_end_ms - line_start_ms),
            }
        )
    return entries


def _parse_milliseconds_synced_line(line: str) -> list[dict] | None:
    if not line:
        return None
    match = _YRC_LINE_RE.fullmatch(line.strip())
    if match is None:
        return None
    try:
        time_ms = int(match.group(1))
    except ValueError:
        return None
    text = _clean_inline_word_timing_text(match.group(2))
    return [{"time": time_ms, "text": text}]


def _merge_line_synced_translations(entries: list[dict]) -> list[dict]:
    merged: dict[int, dict] = {}
    for entry in entries:
        existing = merged.get(entry["time"])
        if existing is None:
            merged[entry["time"]] = entry
            continue
        if not existing["text"].strip() and entry["text"].strip():
            merged[entry["time"]] = {
                **entry,
                "translation": existing.get("translation") or entry.get("translation"),
            }
            continue
        if not entry["text"].strip():
            continue
        translated = _WHITESPACE_RE.sub(" ", entry["text"]).strip()
        if (
            translated
            and translated.lower() != existing["text"].strip().lower()
            and existing.get("translation") is None
        ):
            merged[entry["time"]] = {**existing, "translation": translated}
    return list(merged.values())


def _first_line_timestamp_ms(line: str) -> int | None:
    match = _LINE_RE.fullmatch(line.strip())
    if match is None:
        return None
    first = next(_TIME_RE.finditer(match.group(1)), None)
    return _lrc_timestamp_ms(first) if first else None


def _find_next_line_start_ms(
    lines: list[str], current_index: int, current_line_start_ms: int | None
) -> int | None:
    for index in range(current_index + 1, len(lines)):
        candidate = _first_line_timestamp_ms(lines[index])
        if candidate is None:
            continue
        if current_line_start_ms is None or candidate > current_line_start_ms:
            return candidate
    return None


def _lrc_timestamp_ms(match: re.Match) -> int | None:
    try:
        minutes = int(match.group(1))
        seconds = int(match.group(2))
    except (TypeError, ValueError):
        return None
    if not 0 <= seconds <= 59:
        return None
    fraction = match.group(3) or ""
    if len(fraction) == 0:
        milliseconds = 0
    elif len(fraction) == 1:
        milliseconds = int(fraction) * 100
    elif len(fraction) == 2:
        milliseconds = int(fraction) * 10
    elif len(fraction) == 3:
        milliseconds = int(fraction)
    else:
        return None
    return minutes * 60_000 + seconds * 1000 + milliseconds


def _clean_inline_word_timing_text(text: str) -> str:
    cleaned = _ENHANCED_WORD_TIME_RE.sub("", text)
    cleaned = _INLINE_MS_TIME_RE.sub("", cleaned)
    cleaned = _YRC_WORD_TIME_RE.sub("", cleaned)
    return _WHITESPACE_RE.sub(" ", cleaned).strip()


# ── Instrumental breaks ────────────────────────────────────────────────────


def insert_instrumental_breaks(entries: list[dict], song_duration_ms: int = 0) -> list[dict]:
    """Insert intro/outro instrumental entries (output-line shape, ``timeMs``)."""
    if not entries:
        return entries
    result: list[dict] = []
    first_vocal = next(
        (e for e in entries if e["timeMs"] >= 0 and e["text"].strip()), None
    )
    if first_vocal is not None:
        intro_gap_ms = first_vocal["timeMs"] - _INSTRUMENTAL_INTRO_START_MS
        if intro_gap_ms >= _INSTRUMENTAL_GAP_THRESHOLD_MS:
            result.append(
                {
                    "timeMs": _INSTRUMENTAL_INTRO_START_MS,
                    "endTimeMs": first_vocal["timeMs"],
                    "text": "",
                    "isInstrumental": True,
                    "durationMs": intro_gap_ms,
                }
            )
    result.extend(entries)
    if song_duration_ms > 0:
        last_vocal = next(
            (e for e in reversed(entries) if e["text"].strip()), None
        )
        if last_vocal is not None:
            outro_start_ms = last_vocal["timeMs"] + _INSTRUMENTAL_OUTRO_VOCAL_TAIL_MS
            outro_duration_ms = song_duration_ms - outro_start_ms
            if outro_duration_ms >= _INSTRUMENTAL_GAP_THRESHOLD_MS:
                result.append(
                    {
                        "timeMs": outro_start_ms,
                        "endTimeMs": song_duration_ms,
                        "text": "",
                        "isInstrumental": True,
                        "durationMs": outro_duration_ms,
                    }
                )
    return result


# ── Entry → output line ────────────────────────────────────────────────────


def _entry_to_line(entry: dict) -> dict:
    time_ms = int(entry["time"])
    line: dict = {
        "timeMs": time_ms,
        "endTimeMs": time_ms,
        "text": entry["text"],
    }
    duration_ms = entry.get("durationMs")
    if duration_ms:
        line["endTimeMs"] = time_ms + int(duration_ms)
        line["durationMs"] = int(duration_ms)
    elif entry.get("endMs") is not None:
        line["endTimeMs"] = int(entry["endMs"])
    words = entry.get("words")
    if words:
        line["words"] = [
            {
                "text": word["text"],
                "startMs": max(0, round(word["start"] * 1000.0)),
                "endMs": max(0, round(word["end"] * 1000.0)),
                "isBackground": bool(word.get("isBackground", False)),
            }
            for word in words
        ]
        # Word end times fall back to the next word / line end, mirroring
        # the Android renderers; keep ends strictly after starts.
        for index, word in enumerate(line["words"]):
            if word["endMs"] <= word["startMs"]:
                following = line["words"][index + 1] if index + 1 < len(line["words"]) else None
                word["endMs"] = (
                    following["startMs"] if following else word["startMs"] + 1000
                )
                if word["endMs"] <= word["startMs"]:
                    word["endMs"] = word["startMs"] + 1
        if not duration_ms:
            line["endTimeMs"] = max(word["endMs"] for word in line["words"])
    agent = entry.get("agent")
    if agent:
        line["agent"] = agent
    translation = entry.get("translation")
    if translation:
        cleaned = _WHITESPACE_RE.sub(" ", translation).strip()
        if cleaned and cleaned.lower() != entry["text"].strip().lower():
            line["translation"] = cleaned
    romanized = _provided_romanization(entry)
    if romanized is not None:
        line["romanizedText"] = romanized
        romanized_words = entry.get("romanizedWords")
        if (
            romanized_words
            and words
            and len(romanized_words) == len(words)
        ):
            line["romanizedWords"] = [
                _WHITESPACE_RE.sub(" ", word).strip() for word in romanized_words
            ]
    if entry.get("isInstrumental"):
        line["isInstrumental"] = True
    return line


def _provided_romanization(entry: dict) -> str | None:
    """Provider romanization, only when usable (see module docstring)."""
    original = entry["text"]
    if not original.strip():
        return None
    romanized = entry.get("romanizedText")
    if romanized is None:
        return None
    normalized = _WHITESPACE_RE.sub(" ", romanized).strip()
    if not normalized or normalized.lower() == original.strip().lower():
        return None
    language = (entry.get("romanizedLanguage") or "").split("-")[0].split("_")[0].lower()
    # Provider-claimed Arabic romanizations are dropped, as on Android.
    if language.startswith("ar"):
        return None
    return normalized
