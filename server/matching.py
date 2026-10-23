"""
Spotify → YouTube Music track matching.

The converter takes each Spotify track's ``title`` + ``artists``, searches
YouTube Music for it, and scores every candidate on three signals:

- **title similarity** (55%) — the strongest signal;
- **artist similarity** (30%) — pairwise best plus collaboration-aware
  token overlap (``"A, B"`` vs ``"A"``, ``"A x B"`` vs ``"B"``);
- **duration closeness** (15%) — within ~30 s counts as a perfect match.

Scores map to a status the UI renders directly:

- ``matched`` (≥ 0.78) — confident, safe to import blindly;
- ``approximate`` (≥ 0.50) — worth a glance (a cover, a live version, …);
- ``not_found`` (< 0.50) — nothing close enough; the track stays Spotify-only.

Pure functions only — no network here, so the whole module is trivially
unit-testable. The caller injects the blocking ``search`` callable.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Callable

from .filters import parse_duration_seconds
from .spotify import SpotifyTrack

# Score thresholds for the three match statuses.
MATCHED_THRESHOLD = 0.78
APPROXIMATE_THRESHOLD = 0.50

# Signal weights — they must add up to 1.
TITLE_WEIGHT = 0.55
ARTIST_WEIGHT = 0.30
DURATION_WEIGHT = 0.15

# A title this dissimilar can never be a real match, however good the
# artist looks (prevents "wrong song, right artist" false positives).
TITLE_FLOOR = 0.45

# Spotify loves suffixes like " - Remastered 2011" that YouTube Music drops.
# Strip them before comparing so "…Remastered" still matches the original.
_VERSION_SUFFIX_RES = [
    re.compile(r"\s*-\s*.*\bremaster\w*\b.*$", re.IGNORECASE),
    re.compile(r"\s*-\s*(single|ep|deluxe|expanded|anniversary|tour)\b.*$", re.IGNORECASE),
]
_PAREN_RE = re.compile(r"\s*[(\[].*?[)\]]")
# Trailing "feat. X" / "ft. X" without parentheses — Spotify and YouTube
# Music disagree on where the feature credit lives.
_FEAT_RE = re.compile(r"\s*\b(feat|ft|featuring)\b\.?\s+[^\-]+$", re.IGNORECASE)
# Collaboration separators inside one artist string: "A, B", "A & B",
# "A x B", "A feat. B". ("with" is deliberately excluded — real band
# names like "With Confidence" would split into nonsense.)
_ARTIST_SPLIT_RE = re.compile(
    r"\s*(?:,|&|\+|\u00d7|\bx\b|\bfeat\b\.?|\bft\b\.?|\bfeaturing\b)\s*",
    re.IGNORECASE,
)


def normalize_text(value: str | None) -> str:
    """Lowercase, de-accent, de-punctuate — the canonical compare form."""
    text = unicodedata.normalize("NFKD", value or "")
    text = "".join(char for char in text if not unicodedata.combining(char))
    text = text.lower()
    text = _PAREN_RE.sub(" ", text)
    for pattern in _VERSION_SUFFIX_RES:
        text = pattern.sub("", text)
    text = _FEAT_RE.sub("", text)
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def similarity(left: str | None, right: str | None) -> float:
    """0–1 string similarity on the normalized forms."""
    left_norm, right_norm = normalize_text(left), normalize_text(right)
    if not left_norm or not right_norm:
        return 0.0
    if left_norm == right_norm:
        return 1.0
    # Token containment (multi-token titles only): "blinding lights" inside
    # "blinding lights single" is the same song with a suffix, not a
    # coincidence. Single-token titles skip this — "up" inside "stand up"
    # would be a false friend.
    left_tokens = set(left_norm.split())
    right_tokens = set(right_norm.split())
    if (
        len(left_tokens) >= 2
        and len(right_tokens) >= 2
        and (left_tokens <= right_tokens or right_tokens <= left_tokens)
    ):
        return 0.93
    return SequenceMatcher(None, left_norm, right_norm).ratio()


def ytm_artist_names(item: dict) -> list[str]:
    """Artist display names out of a YouTube Music search item, any shape."""
    artists = item.get("artists")
    names: list[str] = []
    if isinstance(artists, str):
        names.append(artists)
    elif isinstance(artists, list):
        for artist in artists:
            if isinstance(artist, str) and artist.strip():
                names.append(artist.strip())
            elif isinstance(artist, dict) and artist.get("name"):
                names.append(str(artist["name"]).strip())
    artist = item.get("artist")
    if isinstance(artist, str) and artist.strip():
        names.append(artist.strip())
    # de-dupe, keep order
    seen: set[str] = set()
    unique: list[str] = []
    for name in names:
        key = normalize_text(name)
        if key and key not in seen:
            seen.add(key)
            unique.append(name)
    return unique


def _artist_tokens(name: str) -> set[str]:
    """Split one artist string into its collaborators: "A, B" → {"a", "b"}."""
    return {
        token
        for part in _ARTIST_SPLIT_RE.split(name or "")
        if (token := normalize_text(part))
    }


def artist_similarity(spotify_artists: list[str], ytm_item: dict) -> float:
    """
    Best artist similarity across both sides.

    Two lanes: pairwise string similarity (with the "Beatles"/"The Beatles"
    containment fast-lane) and collaboration-aware token overlap, so
    Spotify's ``["KAROL G", "Judeline"]`` still matches YouTube Music's
    ``"KAROL G"`` — sharing the headliner is strong evidence.
    """
    candidates = ytm_artist_names(ytm_item)
    if not spotify_artists or not candidates:
        return 0.0
    best = 0.0
    for spotify_artist in spotify_artists:
        spotify_norm = normalize_text(spotify_artist)
        spotify_tokens = _artist_tokens(spotify_artist)
        for candidate in candidates:
            candidate_norm = normalize_text(candidate)
            score = similarity(spotify_artist, candidate)
            # "The Beatles" vs "Beatles" (or vice versa) is the same act.
            if spotify_norm and candidate_norm and (
                spotify_norm in candidate_norm or candidate_norm in spotify_norm
            ):
                score = max(score, 0.92)
            # Token overlap: any shared collaborator counts; a full set
            # match is as good as an exact string match.
            candidate_tokens = _artist_tokens(candidate)
            shared = spotify_tokens & candidate_tokens
            if shared:
                union = spotify_tokens | candidate_tokens
                score = max(score, 0.60 + 0.40 * len(shared) / len(union))
            best = max(best, score)
    return best


def ytm_duration_seconds(item: dict) -> int | None:
    """Duration of a YouTube Music item in seconds, any key shape."""
    seconds = parse_duration_seconds(item.get("duration_seconds"))
    if seconds is not None:
        return seconds
    return parse_duration_seconds(item.get("duration"))


def duration_score(spotify_ms: int, ytm_item: dict) -> float:
    """
    1.0 when the durations agree within ~30 s, fading to 0 past that.

    Unknown YouTube Music duration scores neutral (0.5) — absence of
    evidence is not evidence of a wrong match.
    """
    ytm_seconds = ytm_duration_seconds(ytm_item)
    if not spotify_ms or ytm_seconds is None:
        return 0.5
    diff = abs(spotify_ms / 1000.0 - ytm_seconds)
    return max(0.0, 1.0 - diff / 30.0)


def score_candidate(spotify_track: SpotifyTrack, ytm_item: dict) -> float:
    """Weighted 0–1 match score for one YouTube Music candidate."""
    title_sim = similarity(spotify_track.title, str(ytm_item.get("title") or ""))
    if title_sim < TITLE_FLOOR:
        return 0.0
    artist_sim = artist_similarity(spotify_track.artists, ytm_item)
    duration = duration_score(spotify_track.duration_ms, ytm_item)
    return TITLE_WEIGHT * title_sim + ARTIST_WEIGHT * artist_sim + DURATION_WEIGHT * duration


def status_for_score(score: float) -> str:
    if score >= MATCHED_THRESHOLD:
        return "matched"
    if score >= APPROXIMATE_THRESHOLD:
        return "approximate"
    return "not_found"


@dataclass
class TrackMatch:
    """The converter's verdict for one Spotify track."""

    track: SpotifyTrack
    status: str  # "matched" | "approximate" | "not_found" | "error"
    confidence: float  # 0–1, the winning candidate's score
    match: dict | None = None  # the raw YouTube Music item (sanitized later)
    error: str | None = None


# Blocking YouTube Music search for one query string, injected so tests can
# stub it. Callers bake in filter/limit via functools.partial.
SearchFn = Callable[[str], list]


def _search_candidates(search: SearchFn, query: str) -> list:
    try:
        results = search(query)
    except Exception:  # noqa: BLE001 — one bad query must not kill the batch
        return []
    return [item for item in results or [] if isinstance(item, dict)]


def _search_queries(spotify_track: SpotifyTrack) -> list[str]:
    """
    Query cascade, cheapest first:

    1. ``"<title> <first artist>"`` — nails the common case;
    2. ``"<normalized title> <first artist>"`` — version suffixes like
       " - Remastered 2011" actively confuse YouTube's search, so retry
       without them;
    3. bare ``"<title>"`` — last resort when the artist spelling differs.
    """
    primary_artist = spotify_track.artists[0] if spotify_track.artists else ""
    title = spotify_track.title or ""
    queries = [f"{title} {primary_artist}".strip()]
    normalized_title = normalize_text(title)
    if normalized_title and normalize_text(title) != title.lower().strip():
        queries.append(f"{normalized_title} {primary_artist}".strip())
    if title:
        queries.append(title)
    # de-dupe, keep order, drop empties
    seen: set[str] = set()
    unique: list[str] = []
    for query in queries:
        if query and query not in seen:
            seen.add(query)
            unique.append(query)
    return unique


def match_track(spotify_track: SpotifyTrack, search: SearchFn) -> TrackMatch:
    """
    Find the best YouTube Music match for one Spotify track.

    Walks the query cascade, stopping as soon as a candidate scores a
    confident match — most tracks resolve on the first query, hard ones
    get the extra searches they need.
    """
    best_item: dict | None = None
    best_score = 0.0
    for query in _search_queries(spotify_track):
        for candidate in _search_candidates(search, query):
            score = score_candidate(spotify_track, candidate)
            if score > best_score:
                best_score = score
                best_item = candidate
        if best_score >= MATCHED_THRESHOLD:
            break

    status = status_for_score(best_score)
    if status == "not_found":
        return TrackMatch(track=spotify_track, status="not_found", confidence=round(best_score, 3))
    return TrackMatch(
        track=spotify_track,
        status=status,
        confidence=round(best_score, 3),
        match=best_item,
    )
