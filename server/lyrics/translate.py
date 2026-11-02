"""Lyrics translation — a port of ``StandardLyricsTranslationRepository``
and the batching in ``TranslateLyricsUseCase``.

The repository POSTs a form to Google's translate endpoint
(``client=at``, ``dt=t``, ``sl=auto``) with ``User-Agent: Carmen
Android`` and reads the translated text out of the first JSON array's
segments. The use-case batching (at most 50 segments / 4000 chars per
call, joined with a unique ``<<<SEP-<uuid>>>>`` separator whose survival
is verified by a boundary-count check) is preserved in
:func:`translate_segments`.

This is only ever called on an explicit user action — never from the
default lyrics chain.
"""

from __future__ import annotations

import re
import uuid

import httpx

_TRANSLATE_URL = "https://translate.googleapis.com/translate_a/single"
_USER_AGENT = "Carmen Android"
_MAX_ITEMS_PER_BATCH = 50
_MAX_CHARS_PER_BATCH = 4000
_SEPARATOR_LENGTH = 46

# From TranslateLyricsUseCase.LanguageCodeAliases (uppercase name -> code).
LANGUAGE_CODE_ALIASES = {
    "ASSAMESE": "as",
    "BURMESE": "my",
    "HAITIAN_CREOLE": "ht",
    "HEBREW": "he",
    "KINYARWANDA": "rw",
    "NYANJA_CHICHEWA": "ny",
    "ODIA_ORIYA": "or",
    "SUNDANESE": "su",
    "TATAR": "tt",
    "TURKMEN": "tk",
    "UIGHUR": "ug",
}

_LANGUAGE_CODE_RE = re.compile(r"^[a-z]{2,3}$")


class TranslationError(RuntimeError):
    """The translation service failed or returned unusable data."""


def resolve_language_code(language: str) -> str | None:
    """Resolve a target language to a 2-3 letter code, or ``None``.

    Accepts the alias names from ``TranslateLyricsUseCase`` (case
    insensitive) and bare 2-3 letter codes; anything else is unsupported.
    """
    if language is None:
        return None
    normalized = str(language).strip()
    alias = LANGUAGE_CODE_ALIASES.get(normalized.upper())
    if alias is not None:
        return alias
    code = normalized.lower()
    if _LANGUAGE_CODE_RE.match(code):
        return code
    return None


def translate_text(text: str, target_language_code: str) -> str:
    """One repository call: translate *text* into *target_language_code*."""
    try:
        response = httpx.post(
            _TRANSLATE_URL,
            data={
                "client": "at",
                "dt": "t",
                "ie": "UTF-8",
                "oe": "UTF-8",
                "sl": "auto",
                "tl": target_language_code,
                "q": text,
            },
            headers={"User-Agent": _USER_AGENT},
            timeout=httpx.Timeout(30.0, connect=15.0),
        )
    except httpx.HTTPError as exc:
        raise TranslationError(f"Translation request failed: {exc}") from exc
    if not 200 <= response.status_code <= 299:
        raise TranslationError(
            f"Translation service returned HTTP {response.status_code}"
        )
    try:
        payload = response.json()
        segments = payload[0]
    except Exception as exc:
        raise TranslationError(
            "Translation service returned malformed data"
        ) from exc
    translated = "".join(
        segment[0] for segment in segments if isinstance(segment, list) and segment
    )
    if not translated.strip():
        raise TranslationError("Translation service returned empty translated text")
    return translated


def _unique_separator(segments: list[str]) -> str:
    separator = f"<<<SEP-{uuid.uuid4()}>>>"
    while any(separator in segment for segment in segments):
        separator = f"<<<SEP-{uuid.uuid4()}>>>"
    return separator


def _chunk_segments(segments: list[str]) -> list[list[str]]:
    chunks: list[list[str]] = []
    current: list[str] = []
    current_chars = 0
    for segment in segments:
        separator_chars = 0 if not current else _SEPARATOR_LENGTH
        next_size = current_chars + separator_chars + len(segment)
        if current and (
            len(current) >= _MAX_ITEMS_PER_BATCH or next_size > _MAX_CHARS_PER_BATCH
        ):
            chunks.append(current)
            current = []
            current_chars = 0
        if current:
            current_chars += _SEPARATOR_LENGTH
        current.append(segment)
        current_chars += len(segment)
    if current:
        chunks.append(current)
    return chunks


def translate_segments(segments: list[str], target_language_code: str) -> list[str]:
    """Translate lyric segments, preserving segment boundaries.

    Raises :class:`TranslationError` when the service changes the segment
    boundaries (the separator count no longer matches), exactly as the
    Android use case does.
    """
    translated: list[str] = []
    for batch in _chunk_segments(segments):
        separator = _unique_separator(batch)
        joined = separator.join(batch)
        translated_text = translate_text(joined, target_language_code)
        translated_batch = translated_text.split(separator)
        if len(translated_batch) != len(batch):
            raise TranslationError(
                "Translation service changed lyric segment boundaries"
            )
        translated.extend(translated_batch)
    return translated


def translate_lyrics_text(text: str, target: str) -> str:
    """Translate a whole lyrics text (lines = segments) into *target*."""
    code = resolve_language_code(target)
    if code is None:
        raise TranslationError(f"Unsupported language: {target!r}")
    if not text.strip():
        raise TranslationError("Nothing to translate")
    segments = text.split("\n")
    return "\n".join(translate_segments(segments, code))
