"""QRC lyric parsing — a port of ``QRCParser`` (betterlyrics module).

QRC lines look like ``[startMs,durationMs]word(start,dur)word(start,dur)``.
A document may also arrive wrapped in XML carrying a ``LyricContent="..."``
attribute; the lyric text is extracted from that attribute first.

No romanization is generated here — that behaviour is deliberately not
ported (see ``parse.py``).
"""

from __future__ import annotations

import re

_LINE_TIMING_RE = re.compile(r"^\[(\d{1,8}),(\d{1,8})\](.*)$")
_WORD_TIMING_RE = re.compile(r"(.*?)\((\d{1,8}),(\d{1,8})(?:,\d{1,8})?\)")
_METADATA_RE = re.compile(r"^\[([A-Za-z]+):(.*)\]$")
_LYRIC_CONTENT_ATTR_RE = re.compile(r'LyricContent\s*=\s*"', re.IGNORECASE)

_METADATA_PREFIXES = {
    "词",
    "作词",
    "曲",
    "作曲",
    "编曲",
    "和声",
    "混音",
    "吉他",
    "制作人",
    "演唱",
    "原唱",
    "翻唱",
    "后期",
    "和音",
    "录音",
    "策划",
    "伴奏",
    "美工",
    "海报",
    "旁白",
    "writtenby",
    "producedby",
    "composedby",
    "arrangedby",
    "mixing",
    "mastering",
    "vocal",
    "vocals",
    "guitar",
    "bass",
    "drums",
    "producer",
    "lyricist",
    "composer",
    "arranger",
    "lyricsby",
}


def is_qrc(content: str) -> bool:
    if "<qrcinfos" in content.lower() or "lyriccontent=" in content.lower():
        return True
    return any(
        (m := _LINE_TIMING_RE.match(line.strip())) is not None
        and _WORD_TIMING_RE.search(m.group(3)) is not None
        for line in content.splitlines()
    )


def has_word_timings(content: str) -> bool:
    return any(
        (m := _LINE_TIMING_RE.match(line.strip())) is not None
        and _WORD_TIMING_RE.search(m.group(3)) is not None
        for line in _extract_lyric_content(content).splitlines()
    )


def parse_qrc(content: str) -> list[dict]:
    """Parse QRC text into line dicts (times in seconds, as in Kotlin)."""
    lyric_content = _extract_lyric_content(content)
    title, artist = _read_metadata(lyric_content)
    aliases: dict[str, str] = {}
    next_voice_id = 1
    current_singer: str | None = None

    # Mutable parsed lines, mirroring MutableParsedLine in Kotlin.
    parsed: list[dict] = []

    for raw_line in lyric_content.splitlines():
        trimmed = raw_line.strip()
        if not trimmed or _METADATA_RE.match(trimmed):
            continue
        match = _LINE_TIMING_RE.match(trimmed)
        if match is None:
            continue
        words = [
            {
                "text": m.group(1),
                "start_ms": int(m.group(2)),
                "duration_ms": int(m.group(3)),
            }
            for m in _WORD_TIMING_RE.finditer(match.group(3))
        ]
        words = [w for w in words if w["text"]]
        if not words:
            continue
        line = {
            "text": "".join(w["text"] for w in words),
            "start_ms": int(match.group(1)),
            "duration_ms": int(match.group(2)),
            "words": words,
            "agent": None,
        }
        kept, aliases, next_voice_id, current_singer = _extract_singer(
            line, aliases, next_voice_id, current_singer,
            is_first_few=len(parsed) < 5, title=title, artist=artist,
        )
        if kept:
            parsed.append(line)

    out: list[dict] = []
    for index, line in enumerate(parsed):
        next_start = parsed[index + 1]["start_ms"] if index + 1 < len(parsed) else None
        last_word = line["words"][-1] if line["words"] else None
        fallback_end = (
            (last_word["start_ms"] + last_word["duration_ms"])
            if last_word is not None
            else next_start if next_start is not None else line["start_ms"]
        )
        if line["duration_ms"] > 0:
            line_end_ms = line["start_ms"] + line["duration_ms"]
        elif next_start is not None:
            line_end_ms = next_start
        else:
            line_end_ms = fallback_end
        line_end_ms = max(line_end_ms, line["start_ms"])
        parsed_words = []
        for wi, word in enumerate(line["words"]):
            next_word_start = (
                line["words"][wi + 1]["start_ms"] if wi + 1 < len(line["words"]) else None
            )
            if word["duration_ms"] > 0:
                word_end = word["start_ms"] + word["duration_ms"]
            elif next_word_start is not None:
                word_end = next_word_start
            else:
                word_end = line_end_ms
            word_end = max(word_end, word["start_ms"])
            parsed_words.append(
                {
                    "text": word["text"],
                    "start": word["start_ms"] / 1000.0,
                    "end": word_end / 1000.0,
                }
            )
        out.append(
            {
                "text": line["text"].strip(),
                "start": line["start_ms"] / 1000.0,
                "end": line_end_ms / 1000.0,
                "words": parsed_words,
                "agent": line["agent"],
            }
        )
    return out


def _extract_lyric_content(content: str) -> str:
    match = _LYRIC_CONTENT_ATTR_RE.search(content)
    if match is None:
        return content
    value_start = match.end()
    value_end = content.find('"', value_start)
    if value_end < 0:
        return content
    return _unescape_xml(content[value_start:value_end])


def _unescape_xml(value: str) -> str:
    return (
        value.replace("&quot;", '"')
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
    )


def _read_metadata(content: str) -> tuple[str | None, str | None]:
    title = artist = None
    for line in content.splitlines():
        match = _METADATA_RE.match(line.strip())
        if match is None:
            continue
        key = match.group(1).lower()
        value = match.group(2).strip()
        if key == "ti":
            title = value or None
        elif key == "ar":
            artist = value or None
    return title, artist


def _extract_singer(line, aliases, next_voice_id, current_singer, *, is_first_few, title, artist):
    """Mirror QRCParser.extractSinger; returns (kept, aliases, next_id, singer)."""
    if is_first_few and _is_metadata_line(line, title, artist):
        return False, aliases, next_voice_id, current_singer

    text = line["text"]
    colon_index = next(
        (i for i, ch in enumerate(text) if ch == ":" or ch == "："), -1
    )
    if colon_index < 0:
        line["agent"] = current_singer
        return True, aliases, next_voice_id, current_singer

    singer_name = text[:colon_index].strip()
    if _is_metadata_prefix(singer_name):
        return False, aliases, next_voice_id, current_singer
    if not singer_name or len(singer_name) > 30:
        line["agent"] = current_singer
        return True, aliases, next_voice_id, current_singer

    if singer_name in aliases:
        agent = aliases[singer_name]
    else:
        normalized = singer_name.upper()
        if normalized in ("合", "ALL", "合唱"):
            agent = "v1000"
        else:
            agent = f"v{next_voice_id}"
            next_voice_id += 1
        aliases[singer_name] = agent
    current_singer = agent

    _remove_character_prefix(line["words"], colon_index + 1)
    line["text"] = "".join(w["text"] for w in line["words"]).strip()
    if not line["text"] or not line["words"]:
        return False, aliases, next_voice_id, current_singer

    line["agent"] = agent
    first_word = line["words"][0]
    last_word = line["words"][-1]
    line["start_ms"] = first_word["start_ms"]
    line["duration_ms"] = max(
        0, last_word["start_ms"] + last_word["duration_ms"] - first_word["start_ms"]
    )
    return True, aliases, next_voice_id, current_singer


def _is_metadata_line(line, title, artist) -> bool:
    normalized_text = _normalize_for_comparison(line["text"])
    normalized_title = _normalize_for_comparison(title) if title else ""
    normalized_artist = _normalize_for_comparison(artist) if artist else ""
    if (
        normalized_title
        and normalized_title in normalized_text
        and (not normalized_artist or normalized_artist in normalized_text)
    ):
        return True
    if normalized_artist and normalized_text == normalized_artist:
        return True
    words = line["words"]
    return len(words) > 2 and all(
        abs(w["duration_ms"] - words[0]["duration_ms"]) < 10 for w in words
    )


def _is_metadata_prefix(value: str) -> bool:
    normalized = _normalize_for_comparison(value)
    return (
        normalized in _METADATA_PREFIXES
        or normalized.endswith("词")
        or normalized.endswith("曲")
        or normalized.endswith("声")
        or normalized.endswith("音")
    )


def _normalize_for_comparison(value: str) -> str:
    return "".join(ch.lower() for ch in value if ch.isalnum())


def _remove_character_prefix(words: list[dict], character_count: int) -> None:
    remaining = character_count
    retained: list[dict] = []
    for word in words:
        if remaining >= len(word["text"]):
            remaining -= len(word["text"])
        elif remaining > 0:
            retained_text = word["text"][remaining:].lstrip()
            remaining = 0
            if retained_text:
                retained.append({**word, "text": retained_text})
        else:
            retained.append(word)
    while retained and not retained[0]["text"].strip():
        retained.pop(0)
    if retained:
        retained[0] = {**retained[0], "text": retained[0]["text"].lstrip()}
    words.clear()
    words.extend(retained)
