"""Megalobiz provider — port of ``MegalobizLyricsProvider.kt``.

Self-contained HTML scrape: search ``https://www.megalobiz.com/searchall``
for ``"<artist> <title>"``, take the first
``/lrc/maker/download/...`` link, fetch that page, extract the
``lrc_*_details`` span, unescape the three entities, turn ``<br>`` into
newlines, strip tags, and only return the result when it is line-synced
LRC — exactly as in Kotlin.
"""

from __future__ import annotations

import re
from urllib.parse import quote_plus

from ._http import http_get_text
from .parse import is_line_synced_lrc

NAME = "Megalobiz"
ID = "megalobiz"

_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
_LRC_PATH_RE = re.compile(r"""href=["'](/lrc/maker/download/[^"']+)["']""")
_LRC_SPAN_RE = re.compile(
    r"""id=["']lrc_[^"']*_details["'][^>]*>(.*?)</span>""", re.DOTALL
)
_HTML_TAG_RE = re.compile(r"<[^>]+>")


def get_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    try:
        query = f"{artist or ''} {title or ''}".strip()
        search_url = (
            "https://www.megalobiz.com/searchall?qry=" + quote_plus(query)
        )
        status, search_html = http_get_text(
            search_url, headers={"User-Agent": _USER_AGENT}, timeout=10.0
        )
        if not 200 <= status <= 299:
            return None
        match = _LRC_PATH_RE.search(search_html)
        if match is None:
            return None
        lrc_url = "https://www.megalobiz.com" + match.group(1)
        status, detail_html = http_get_text(
            lrc_url, headers={"User-Agent": _USER_AGENT}, timeout=10.0
        )
        if not 200 <= status <= 299:
            return None
        span_match = _LRC_SPAN_RE.search(detail_html)
        raw_lrc_text = span_match.group(1) if span_match else detail_html
        cleaned = (
            raw_lrc_text.replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&amp;", "&")
            .replace("<br>", "\n")
            .replace("<br/>", "\n")
            .replace("<br />", "\n")
        )
        cleaned = _HTML_TAG_RE.sub("", cleaned).strip()
        if is_line_synced_lrc(cleaned):
            return cleaned
        return None
    except Exception:
        return None


def get_all_lyrics(video_id, title, artist, album, duration_seconds, api_key=None):
    result = get_lyrics(video_id, title, artist, album, duration_seconds, api_key)
    return [result] if result else []
