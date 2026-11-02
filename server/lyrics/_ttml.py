"""TTML parsing — a port of ``TTMLParser`` (betterlyrics module).

Safe XML only: any ``DOCTYPE``/``ENTITY`` declaration is rejected before
parsing, matching the Kotlin parser's ``disallow-doctype-decl`` setup and
its entity resolver that refuses external entities. Namespace handling is
by local name, and prefixes used in the document but never declared get
the same known-namespace declarations the Kotlin parser injects.

The public entry point is :func:`parse_ttml`, which returns ``[]`` for any
malformed/unsafe document, mirroring ``TTMLParser.parseTTML``'s
``getOrNull`` behaviour. Times are seconds (floats), as in Kotlin.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

_MILLIS_PER_SECOND = 1000.0
_DEFAULT_FINAL_LINE_DURATION_MS = 4000

_WHITESPACE_RE = re.compile(r"\s+")
_OFFSET_TIME_RE = re.compile(r"^([0-9]+(?:\.[0-9]+)?)(ms|h|m|s|f|t)$", re.IGNORECASE)
_UNSAFE_XML_RE = re.compile(r"<!\s*(?:DOCTYPE|ENTITY)\b", re.IGNORECASE)
_ROOT_TAG_RE = re.compile(
    r"<(?:[A-Za-z_][\w.-]*:)?tt\b[^>]*>", re.IGNORECASE | re.DOTALL
)
_NAMESPACE_DECL_RE = re.compile(r"\bxmlns:([A-Za-z_][\w.-]*)\s*=", re.IGNORECASE)
_KNOWN_NAMESPACES = {
    "ttm": "http://www.w3.org/ns/ttml#metadata",
    "tts": "http://www.w3.org/ns/ttml#styling",
    "ttp": "http://www.w3.org/ns/ttml#parameter",
    "itunes": "http://music.apple.com/lyric-ttml-internal",
    "amll": "http://www.example.com/ns/amll",
    "composer": "http://composer.boidu.dev/ttml",
}
_SUPPLEMENTARY_ROLES = {"x-bg", "x-translation", "x-roman"}


class TtmlParseError(ValueError):
    """Raised for malformed, unsafe, or timing-less TTML documents."""


# ── Model ──────────────────────────────────────────────────────────────────


@dataclass
class _Timing:
    tick_rate: float
    frame_rate: float


@dataclass
class _RawSegment:
    text: str
    begin_ms: int | None = None
    end_ms: int | None = None
    duration_ms: int | None = None


@dataclass
class _RawTrack:
    text: str
    language: str | None
    segments: list[_RawSegment] = field(default_factory=list)
    begin_ms: int | None = None
    end_ms: int | None = None
    duration_ms: int | None = None


@dataclass
class _RawLine:
    key: str | None
    source_order: int
    begin_ms: int | None
    end_ms: int | None
    duration_ms: int | None
    agent_id: str | None
    main: _RawTrack
    backgrounds: list[_RawTrack]
    translations: list[_RawTrack]
    romanizations: list[_RawTrack]

    def all_tracks(self):
        return [self.main, *self.backgrounds, *self.translations, *self.romanizations]


@dataclass
class _Segment:
    text: str
    timing: tuple[int, int] | None  # (start_ms, end_ms)


@dataclass
class _Track:
    text: str
    language: str | None
    segments: list[_Segment] = field(default_factory=list)


@dataclass
class _Agent:
    id: str
    name: str | None
    type: str
    order: int


@dataclass
class _Line:
    key: str | None
    source_order: int
    start_ms: int
    end_ms: int
    text: str
    main: _Track
    backgrounds: list[_Track]
    translations: list[_Track]
    romanizations: list[_Track]
    agent: _Agent | None


# ── Public API ─────────────────────────────────────────────────────────────


def parse_ttml(ttml: str) -> list[dict]:
    """Parse TTML into line dicts; ``[]`` when the document is unusable."""
    try:
        document = _parse_document(ttml)
    except Exception:
        return []
    lines = []
    for line in document:
        main_words = [
            {
                "text": seg.text,
                "start": seg.timing[0] / _MILLIS_PER_SECOND,
                "end": seg.timing[1] / _MILLIS_PER_SECOND,
                "isBackground": False,
            }
            for seg in line.main.segments
            if seg.timing is not None
        ]
        background_words = [
            {
                "text": seg.text,
                "start": seg.timing[0] / _MILLIS_PER_SECOND,
                "end": seg.timing[1] / _MILLIS_PER_SECOND,
                "isBackground": True,
            }
            for track in line.backgrounds
            for seg in track.segments
            if seg.timing is not None
        ]
        romanization = _choose_romanization(line.romanizations)
        lines.append(
            {
                "text": line.text,
                "start": line.start_ms / _MILLIS_PER_SECOND,
                "end": line.end_ms / _MILLIS_PER_SECOND,
                "words": main_words + background_words,
                "agent": line.agent.id if line.agent else None,
                "providerRomanizedText": (
                    _normalized_text(romanization.text) if romanization else None
                ),
                "providerRomanizedWords": (
                    [w for w in (_normalized_text(s.text) for s in romanization.segments) if w]
                    or None
                )
                if romanization
                else None,
                "providerRomanizedLanguage": romanization.language if romanization else None,
                "providerTranslationText": (
                    _normalized_text(line.translations[0].text)
                    if line.translations
                    else None
                ),
            }
        )
    return lines


def _parse_document(ttml: str) -> list[_Line]:
    source = ttml.removeprefix("\ufeff").lstrip()
    if _UNSAFE_XML_RE.search(source):
        raise TtmlParseError("unsafe XML")
    root = ET.fromstring(_declare_missing_namespaces(source))
    if _local_name(root.tag) != "tt":
        raise TtmlParseError("malformed XML")

    timing = _read_timing_context(root)
    body = next((el for el in _descendants(root) if _local_name(el.tag) == "body"), None)
    body_start_ms = _attr_time(body, "begin", timing) if body is not None else 0
    body_start_ms = body_start_ms if body_start_ms is not None else 0
    body_end_ms = None
    if body is not None:
        body_end_ms = _attr_time(body, "end", timing)
        if body_end_ms is None:
            dur = _attr_time(body, "dur", timing)
            if dur is not None:
                body_end_ms = body_start_ms + dur
    declared_agents = _parse_agents(root)
    head_romanizations = _parse_head_tracks(root, "transliteration", timing)
    head_translations = _parse_head_tracks(root, "translation", timing)
    raw_lines = _parse_raw_lines(root, timing, head_translations, head_romanizations)
    if not raw_lines:
        raise TtmlParseError("missing lines")
    agents = _resolve_unknown_agents(declared_agents, raw_lines)
    lines = _resolve_lines(raw_lines, body_end_ms, {a.id: a for a in agents})
    if not lines:
        raise TtmlParseError("invalid timing")
    return sorted(lines, key=lambda line: (line.start_ms, line.source_order))


# ── XML helpers ────────────────────────────────────────────────────────────


def _local_name(tag: str) -> str:
    if tag.startswith("{"):
        return tag.rsplit("}", 1)[-1]
    return tag.split(":", 1)[-1]


def _attr(element: ET.Element | None, local_name: str) -> str | None:
    if element is None:
        return None
    for key, value in element.attrib.items():
        candidate = _local_name(key)
        if candidate.lower() == local_name.lower():
            value = value.strip()
            return value or None
    return None


def _inherited_attr(element: ET.Element, local_name: str, parents: dict) -> str | None:
    current: ET.Element | None = element
    while current is not None:
        value = _attr(current, local_name)
        if value is not None:
            return value
        current = parents.get(current)
    return None


def _has_local_name(element: ET.Element, expected: str) -> bool:
    return _local_name(element.tag).lower() == expected.lower()


def _descendants(element: ET.Element):
    for child in element:
        yield child
        yield from _descendants(child)


def _direct_children(element: ET.Element) -> list[ET.Element]:
    return list(element)


def _direct_text(element: ET.Element) -> str:
    parts = []
    if element.text:
        parts.append(element.text)
    for child in element:
        if child.tail:
            parts.append(child.tail)
    return "".join(parts)


def _declare_missing_namespaces(source: str) -> str:
    match = _ROOT_TAG_RE.search(source)
    if match is None:
        return source
    root_tag = match.group(0)
    declared = {m.group(1).lower() for m in _NAMESPACE_DECL_RE.finditer(root_tag)}
    missing = {
        prefix: uri
        for prefix, uri in _KNOWN_NAMESPACES.items()
        if prefix not in declared
        and re.search(rf"\b{re.escape(prefix)}:[A-Za-z_][\w.-]*", source)
    }
    if not missing:
        return source
    declarations = "".join(
        f' xmlns:{prefix}="{uri}"' for prefix, uri in missing.items()
    )
    insertion = match.end() - (2 if root_tag.endswith("/>") else 1)
    return source[:insertion] + declarations + source[insertion:]


def _read_timing_context(root: ET.Element) -> _Timing:
    base = _attr(root, "frameRate")
    try:
        base_rate = float(base) if base is not None else None
    except ValueError:
        base_rate = None
    if base_rate is None or base_rate <= 0:
        base_rate = 30.0
    multiplier = 1.0
    mult_raw = _attr(root, "frameRateMultiplier")
    if mult_raw:
        parts = mult_raw.split()
        try:
            nums = [float(p) for p in parts]
        except ValueError:
            nums = []
        if len(nums) == 2 and nums[0] > 0 and nums[1] > 0:
            multiplier = nums[0] / nums[1]
    frame_rate = max(base_rate * multiplier, 1.0)
    tick_raw = _attr(root, "tickRate")
    try:
        tick_rate = float(tick_raw) if tick_raw is not None else None
    except ValueError:
        tick_rate = None
    if tick_rate is None or tick_rate <= 0:
        tick_rate = frame_rate
    return _Timing(tick_rate=tick_rate, frame_rate=frame_rate)


def _attr_time(element: ET.Element | None, name: str, timing: _Timing) -> int | None:
    raw = _attr(element, name)
    return _parse_time(raw, timing) if raw is not None else None


def _parse_time(raw_value: str, context: _Timing) -> int | None:
    value = raw_value.strip()
    if not value:
        return None
    match = _OFFSET_TIME_RE.match(value)
    if match:
        try:
            amount = float(match.group(1))
        except ValueError:
            return None
        if amount < 0:
            return None
        unit = match.group(2).lower()
        if unit == "h":
            seconds = amount * 3600.0
        elif unit == "m":
            seconds = amount * 60.0
        elif unit == "s":
            seconds = amount
        elif unit == "ms":
            seconds = amount / 1000.0
        elif unit == "f":
            seconds = amount / context.frame_rate
        elif unit == "t":
            seconds = amount / context.tick_rate
        else:
            return None
        return _to_ms(seconds)
    parts = value.replace(";", ":").split(":")
    if len(parts) not in (1, 2, 3, 4):
        return None
    numeric = []
    for part in parts:
        try:
            number = float(part)
        except ValueError:
            return None
        if number < 0:
            return None
        numeric.append(number)
    if len(numeric) >= 2:
        check = numeric[1 : len(numeric) - (1 if len(numeric) == 4 else 0)]
        if any(v >= 60.0 for v in check):
            return None
    if len(numeric) == 1:
        seconds = numeric[0]
    elif len(numeric) == 2:
        seconds = numeric[0] * 60.0 + numeric[1]
    elif len(numeric) == 3:
        seconds = numeric[0] * 3600.0 + numeric[1] * 60.0 + numeric[2]
    else:
        seconds = (
            numeric[0] * 3600.0
            + numeric[1] * 60.0
            + numeric[2]
            + numeric[3] / context.frame_rate
        )
    return _to_ms(seconds)


def _to_ms(seconds: float) -> int | None:
    milliseconds = seconds * 1000.0
    if milliseconds < 0 or milliseconds != milliseconds or milliseconds == float("inf"):
        return None
    return round(milliseconds)


# ── Agents / head tracks ───────────────────────────────────────────────────


def _parse_agents(root: ET.Element) -> list[_Agent]:
    agents = []
    for index, element in enumerate(
        el for el in _descendants(root) if _has_local_name(el, "agent")
    ):
        agent_id = _attr(element, "id")
        if agent_id is None:
            continue
        name_el = next(
            (el for el in _descendants(element) if _has_local_name(el, "name")),
            None,
        )
        name = None
        if name_el is not None:
            text = "".join(name_el.itertext())
            name = _normalized_text(text) or None
        agent_type = {
            "person": "person",
            "character": "character",
            "group": "group",
            "organization": "organization",
        }.get((_attr(element, "type") or "").lower(), "other")
        agents.append(
            _Agent(
                id=agent_id.removeprefix("#"),
                name=name,
                type=agent_type,
                order=index,
            )
        )
    seen = set()
    unique = []
    for agent in agents:
        if agent.id and agent.id not in seen:
            seen.add(agent.id)
            unique.append(agent)
    return unique


def _parse_head_tracks(
    root: ET.Element, container_name: str, timing: _Timing
) -> dict[str, list[_RawTrack]]:
    result: dict[str, list[_RawTrack]] = {}
    for container in (
        el for el in _descendants(root) if _has_local_name(el, container_name)
    ):
        language = _attr(container, "lang")
        for text_el in (
            el
            for el in _descendants(container)
            if _has_local_name(el, "text")
        ):
            line_key = _attr(text_el, "for")
            if line_key is None:
                continue
            line_key = line_key.removeprefix("#")
            track = _parse_generic_track(text_el, language, timing)
            if track.text.strip():
                result.setdefault(line_key, []).append(track)
    return result


# ── Paragraphs / tracks ────────────────────────────────────────────────────


class _TrackBuilder:
    """Mirrors TTMLParser.TrackBuilder, including its pending-prefix rule."""

    def __init__(self, language: str | None):
        self.language = language
        self.text = ""
        self.segments: list[_RawSegment] = []
        self._pending_prefix = ""

    def append_segment(self, segment: _RawSegment) -> None:
        original_text = segment.text
        if self._pending_prefix:
            segment = _RawSegment(
                text=self._pending_prefix + segment.text,
                begin_ms=segment.begin_ms,
                end_ms=segment.end_ms,
                duration_ms=segment.duration_ms,
            )
            self._pending_prefix = ""
        self.segments.append(segment)
        self.text += original_text

    def append_inter_span_text(self, value: str) -> None:
        if "\n" in value or "\r" in value:
            content = value.strip()
            if not content:
                return
        else:
            content = value
            if not content:
                return
        if self.segments:
            self.segments[-1].text += content
        else:
            self._pending_prefix += content
        self.text += content

    def build(
        self,
        begin_ms: int | None = None,
        end_ms: int | None = None,
        duration_ms: int | None = None,
    ) -> _RawTrack:
        return _RawTrack(
            text=self.text,
            language=self.language,
            segments=list(self.segments),
            begin_ms=begin_ms,
            end_ms=end_ms,
            duration_ms=duration_ms,
        )


def _parse_raw_lines(
    root: ET.Element,
    timing: _Timing,
    head_translations: dict[str, list[_RawTrack]],
    head_romanizations: dict[str, list[_RawTrack]],
) -> list[_RawLine]:
    parents = {child: parent for parent in root.iter() for child in parent}
    raw_lines = []
    paragraphs = [el for el in _descendants(root) if _has_local_name(el, "p")]
    for index, paragraph in enumerate(paragraphs):
        content = _parse_paragraph_content(paragraph, timing, parents)
        key = _attr(paragraph, "key") or _attr(paragraph, "id")
        if key is not None:
            key = key.removeprefix("#")
        main_text = _normalized_edge_whitespace(content[0].text)
        if main_text:
            visible_text = main_text
        else:
            visible_text = " ".join(
                _normalized_text(t.text) for t in content[1]
            )
        if not visible_text.strip():
            continue
        agent_id = _inherited_attr(paragraph, "agent", parents)
        if agent_id is not None:
            agent_id = agent_id.removeprefix("#")
        main = _RawTrack(
            text=main_text,
            language=content[0].language,
            segments=content[0].segments,
            begin_ms=content[0].begin_ms,
            end_ms=content[0].end_ms,
            duration_ms=content[0].duration_ms,
        )
        raw_lines.append(
            _RawLine(
                key=key,
                source_order=index,
                begin_ms=_attr_time(paragraph, "begin", timing),
                end_ms=_attr_time(paragraph, "end", timing),
                duration_ms=_attr_time(paragraph, "dur", timing),
                agent_id=agent_id,
                main=main,
                backgrounds=content[1],
                translations=[
                    *content[2],
                    *(head_translations.get(key, []) if key else []),
                ],
                romanizations=[
                    *content[3],
                    *(head_romanizations.get(key, []) if key else []),
                ],
            )
        )
    return raw_lines


def _parse_paragraph_content(
    paragraph: ET.Element, timing: _Timing, parents: dict
) -> tuple[_RawTrack, list[_RawTrack], list[_RawTrack], list[_RawTrack]]:
    language = _inherited_attr(paragraph, "lang", parents)
    main = _TrackBuilder(language)
    backgrounds: list[_RawTrack] = []
    translations: list[_RawTrack] = []
    romanizations: list[_RawTrack] = []
    for node in _child_nodes(paragraph):
        if isinstance(node, str):
            main.append_inter_span_text(node)
        elif _has_local_name(node, "span"):
            role = (_attr(node, "role") or "").lower()
            if role == "x-bg":
                backgrounds.append(_parse_generic_track(node, language, timing))
            elif role == "x-translation":
                translations.append(_parse_generic_track(node, language, timing))
            elif role == "x-roman":
                romanizations.append(_parse_generic_track(node, language, timing))
            else:
                _parse_main_span(
                    node, main, backgrounds, translations, romanizations, timing
                )
    return (
        main.build(),
        [t for t in backgrounds if t.text.strip()],
        [t for t in translations if t.text.strip()],
        [t for t in romanizations if t.text.strip()],
    )


def _child_nodes(element: ET.Element):
    """Yield text/CDATA strings and child elements in document order."""
    if element.text:
        yield element.text
    for child in element:
        yield child
        if child.tail:
            yield child.tail


def _parse_main_span(
    element: ET.Element,
    main: _TrackBuilder,
    backgrounds: list[_RawTrack],
    translations: list[_RawTrack],
    romanizations: list[_RawTrack],
    timing: _Timing,
) -> None:
    direct_spans = [c for c in _direct_children(element) if _has_local_name(c, "span")]
    for child in direct_spans:
        role = (_attr(child, "role") or "").lower()
        if role == "x-bg":
            backgrounds.append(_parse_generic_track(child, main.language, timing))
        elif role == "x-translation":
            translations.append(_parse_generic_track(child, main.language, timing))
        elif role == "x-roman":
            romanizations.append(_parse_generic_track(child, main.language, timing))
    main_children = [c for c in direct_spans if not _has_supplementary_role(c)]
    begin_ms = _attr_time(element, "begin", timing)
    end_ms = _attr_time(element, "end", timing)
    duration_ms = _attr_time(element, "dur", timing)
    if not main_children:
        if not direct_spans:
            text = "".join(element.itertext())
        else:
            text = _direct_text(element)
        if text:
            main.append_segment(
                _RawSegment(text=text, begin_ms=begin_ms, end_ms=end_ms, duration_ms=duration_ms)
            )
        return
    for node in _child_nodes(element):
        if isinstance(node, str):
            main.append_inter_span_text(node)
        elif _has_local_name(node, "span") and not _has_supplementary_role(node):
            _parse_main_span(node, main, backgrounds, translations, romanizations, timing)


def _has_supplementary_role(element: ET.Element) -> bool:
    return (_attr(element, "role") or "").lower() in _SUPPLEMENTARY_ROLES


def _parse_generic_track(
    element: ET.Element, inherited_language: str | None, timing: _Timing
) -> _RawTrack:
    language = _attr(element, "lang") or inherited_language
    builder = _TrackBuilder(language)
    _parse_generic_nodes(element, builder, timing, include_element_timing=True)
    return builder.build(
        begin_ms=_attr_time(element, "begin", timing),
        end_ms=_attr_time(element, "end", timing),
        duration_ms=_attr_time(element, "dur", timing),
    )


def _parse_generic_nodes(
    element: ET.Element,
    builder: _TrackBuilder,
    timing: _Timing,
    include_element_timing: bool,
) -> None:
    span_children = [c for c in _direct_children(element) if _has_local_name(c, "span")]
    begin_ms = _attr_time(element, "begin", timing)
    end_ms = _attr_time(element, "end", timing)
    duration_ms = _attr_time(element, "dur", timing)
    if include_element_timing and not span_children and begin_ms is not None:
        text = "".join(element.itertext())
        if text:
            builder.append_segment(
                _RawSegment(text=text, begin_ms=begin_ms, end_ms=end_ms, duration_ms=duration_ms)
            )
        return
    for node in _child_nodes(element):
        if isinstance(node, str):
            builder.append_inter_span_text(node)
        elif _has_local_name(node, "span"):
            _parse_generic_nodes(node, builder, timing, include_element_timing=True)


# ── Resolution ─────────────────────────────────────────────────────────────


def _resolve_unknown_agents(
    declared: list[_Agent], raw_lines: list[_RawLine]
) -> list[_Agent]:
    agents = list(declared)
    known = {a.id for a in declared}
    for raw_line in raw_lines:
        if raw_line.agent_id and raw_line.agent_id not in known:
            known.add(raw_line.agent_id)
            agents.append(
                _Agent(id=raw_line.agent_id, name=None, type="person", order=len(agents))
            )
    return agents


def _resolve_lines(
    raw_lines: list[_RawLine],
    body_end_ms: int | None,
    agent_by_id: dict[str, _Agent],
) -> list[_Line]:
    preliminary_starts = [
        line.begin_ms if line.begin_ms is not None else _minimum_raw_begin(line)
        for line in raw_lines
    ]
    lines = []
    for index, raw_line in enumerate(raw_lines):
        line_start = preliminary_starts[index]
        if line_start is None:
            continue
        next_start = next(
            (
                start
                for start in preliminary_starts[index + 1 :]
                if start is not None and start > line_start
            ),
            None,
        )
        declared_end = raw_line.end_ms
        if declared_end is None and raw_line.duration_ms is not None:
            declared_end = line_start + raw_line.duration_ms
        if declared_end is not None:
            preliminary_end = declared_end
        else:
            preliminary_end = _maximum_raw_end(raw_line, line_start)
            if preliminary_end is None:
                preliminary_end = next_start
            if preliminary_end is None and body_end_ms is not None and body_end_ms > line_start:
                preliminary_end = body_end_ms
            if preliminary_end is None:
                preliminary_end = _saturated_plus(line_start, _DEFAULT_FINAL_LINE_DURATION_MS)
        if preliminary_end <= line_start:
            continue
        main = _resolve_track(raw_line.main, (line_start, preliminary_end))
        backgrounds = [_resolve_track(t, (line_start, preliminary_end)) for t in raw_line.backgrounds]
        translations = [_resolve_track(t, (line_start, preliminary_end)) for t in raw_line.translations]
        romanizations = [_resolve_track(t, (line_start, preliminary_end)) for t in raw_line.romanizations]
        all_tracks = [main, *backgrounds, *translations, *romanizations]
        timings = [
            seg.timing for track in all_tracks for seg in track.segments if seg.timing
        ]
        effective_start = min([line_start, *[t[0] for t in timings]] or [line_start])
        effective_end = max([preliminary_end, *[t[1] for t in timings]] or [preliminary_end])
        if effective_end <= effective_start:
            continue
        visible_text = _normalized_edge_whitespace(main.text)
        if not visible_text:
            visible_text = " ".join(_normalized_text(t.text) for t in backgrounds)
        lines.append(
            _Line(
                key=raw_line.key,
                source_order=raw_line.source_order,
                start_ms=effective_start,
                end_ms=effective_end,
                text=visible_text,
                main=_Track(
                    text=_normalized_edge_whitespace(main.text),
                    language=main.language,
                    segments=main.segments,
                ),
                backgrounds=[t for t in backgrounds if t.text.strip()],
                translations=[t for t in translations if t.text.strip()],
                romanizations=[t for t in romanizations if t.text.strip()],
                agent=agent_by_id.get(raw_line.agent_id) if raw_line.agent_id else None,
            )
        )
    return lines


def _resolve_track(raw_track: _RawTrack, line_range: tuple[int, int]) -> _Track:
    offset = _determine_track_offset(raw_track, line_range)
    track_start = (
        raw_track.begin_ms + offset if raw_track.begin_ms is not None else line_range[0]
    )
    if raw_track.end_ms is not None:
        track_end = raw_track.end_ms + offset
    elif raw_track.duration_ms is not None:
        track_end = track_start + raw_track.duration_ms
    else:
        track_end = line_range[1]
    starts = [
        (seg.begin_ms + offset) if seg.begin_ms is not None else None
        for seg in raw_track.segments
    ]
    resolved = []
    for idx, segment in enumerate(raw_track.segments):
        start = starts[idx]
        explicit_end = None
        if segment.end_ms is not None:
            explicit_end = segment.end_ms + offset
        elif segment.duration_ms is not None and start is not None:
            explicit_end = start + segment.duration_ms
        next_start = next((s for s in starts[idx + 1 :] if s is not None), None)
        end = explicit_end if explicit_end is not None else next_start if next_start is not None else track_end
        timing = None
        if start is not None and end is not None and end > start and start >= 0:
            timing = (start, end)
        resolved.append(_Segment(text=segment.text, timing=timing))
    if (
        resolved
        and all(seg.timing is None for seg in resolved)
        and raw_track.begin_ms is not None
        and (raw_track.end_ms is not None or raw_track.duration_ms is not None)
        and track_end > track_start
    ):
        resolved = [_Segment(text=raw_track.text, timing=(track_start, track_end))]
    return _Track(
        text=_normalized_edge_whitespace(raw_track.text),
        language=raw_track.language,
        segments=resolved,
    )


def _determine_track_offset(raw_track: _RawTrack, line_range: tuple[int, int]) -> int:
    segment_ranges = []
    for segment in raw_track.segments:
        if segment.begin_ms is None:
            continue
        end = segment.end_ms
        if end is None and segment.duration_ms is not None:
            end = segment.begin_ms + segment.duration_ms
        if end is None:
            end = segment.begin_ms
        segment_ranges.append((segment.begin_ms, end))
    if segment_ranges:
        raw_ranges = segment_ranges
    else:
        if raw_track.begin_ms is None:
            return 0
        start = raw_track.begin_ms
        end = raw_track.end_ms
        if end is None and raw_track.duration_ms is not None:
            end = start + raw_track.duration_ms
        if end is None:
            end = start
        raw_ranges = [(start, end)]
    if not raw_ranges or line_range[0] == 0:
        return 0
    if all(
        start >= line_range[0] and end <= line_range[1] for start, end in raw_ranges
    ):
        return 0
    if all(
        start >= 0
        and line_range[0] + start >= line_range[0]
        and line_range[0] + end <= line_range[1]
        for start, end in raw_ranges
    ):
        return line_range[0]
    return 0


def _minimum_raw_begin(raw_line: _RawLine) -> int | None:
    values = []
    for track in raw_line.all_tracks():
        values.append(track.begin_ms)
        values.extend(seg.begin_ms for seg in track.segments)
    values = [v for v in values if v is not None]
    return min(values) if values else None


def _maximum_raw_end(raw_line: _RawLine, line_start: int) -> int | None:
    values = []
    for track in raw_line.all_tracks():
        track_end = track.end_ms
        if track_end is None and track.begin_ms is not None and track.duration_ms is not None:
            track_end = track.begin_ms + track.duration_ms
        values.append(track_end)
        for segment in track.segments:
            seg_end = segment.end_ms
            if seg_end is None and segment.begin_ms is not None and segment.duration_ms is not None:
                seg_end = segment.begin_ms + segment.duration_ms
            values.append(seg_end)
    values = [v for v in values if v is not None]
    if not values:
        return None
    raw_max = max(values)
    return line_start + raw_max if raw_max < line_start else raw_max


def _saturated_plus(value: int, addition: int) -> int:
    return value + addition


def _choose_romanization(tracks: list[_Track]) -> _Track | None:
    for track in tracks:
        if track.language and "latn" in track.language.lower():
            return track
    return tracks[0] if tracks else None


def _normalized_text(value: str) -> str:
    return _WHITESPACE_RE.sub(" ", value).strip()


def _normalized_edge_whitespace(value: str) -> str:
    # Python's strip() removes Unicode whitespace, including NBSP, matching
    # Kotlin's `trim { isWhitespace() || == NBSP }`.
    return value.strip()
