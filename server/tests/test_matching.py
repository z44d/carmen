"""Tests for server/matching.py — normalization, scoring, match selection."""

import pytest

from server.matching import (
    APPROXIMATE_THRESHOLD,
    MATCHED_THRESHOLD,
    artist_similarity,
    duration_score,
    match_track,
    normalize_text,
    score_candidate,
    similarity,
    status_for_score,
    ytm_artist_names,
    ytm_duration_seconds,
)
from server.spotify import SpotifyTrack


def sp_track(title="Blinding Lights", artists=("The Weeknd",), duration_ms=202_000):
    return SpotifyTrack(id="s1", title=title, artists=list(artists), duration_ms=duration_ms)


def ytm_item(title="Blinding Lights", artists=("The Weeknd",), duration="3:22", **extra):
    item = {
        "videoId": "abc123",
        "title": title,
        "artists": [{"name": a} for a in artists],
        "duration": duration,
        "thumbnails": [{"url": "https://i.ytimg.com/vi/abc123/hqdefault.jpg"}],
    }
    item.update(extra)
    return item


# ── normalization ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Blinding Lights", "blinding lights"),
        ("Beyoncé", "beyonce"),
        ("Halo (Remastered)", "halo"),
        ("Song [Live]", "song"),
        ("Bohemian Rhapsody - Remastered 2011", "bohemian rhapsody"),
        ("  Hello   World  ", "hello world"),
        ("Rock & Roll!", "rock roll"),
        ("", ""),
        (None, ""),
    ],
)
def test_normalize_text(raw, expected):
    assert normalize_text(raw) == expected


def test_similarity_basics():
    assert similarity("Hello", "hello") == 1.0
    assert similarity("abc", "xyz") < 0.5
    assert similarity("", "x") == 0.0
    assert similarity(None, None) == 0.0


# ── artist extraction ─────────────────────────────────────────────────────


def test_ytm_artist_names_any_shape():
    assert ytm_artist_names({"artists": [{"name": "A"}, {"name": "B"}]}) == ["A", "B"]
    assert ytm_artist_names({"artists": ["A", "B"]}) == ["A", "B"]
    assert ytm_artist_names({"artists": [{"name": "A"}], "artist": "A"}) == ["A"]
    assert ytm_artist_names({"artist": "Solo"}) == ["Solo"]
    assert ytm_artist_names({}) == []


def test_artist_similarity_containment_bonus():
    item = ytm_item(artists=("Beatles",))
    assert artist_similarity(["The Beatles"], item) >= 0.9
    assert artist_similarity(["Queen"], ytm_item(artists=("Queen",))) == 1.0
    assert artist_similarity(["Queen"], ytm_item(artists=("ABBA",))) < 0.5
    assert artist_similarity([], ytm_item()) == 0.0


def test_ytm_duration_seconds_shapes():
    assert ytm_duration_seconds({"duration": "3:22"}) == 202
    assert ytm_duration_seconds({"duration_seconds": 202}) == 202
    assert ytm_duration_seconds({}) is None


def test_duration_score():
    assert duration_score(202_000, ytm_item(duration="3:22")) == pytest.approx(1.0)
    assert duration_score(202_000, ytm_item(duration="3:52")) == pytest.approx(0.0)
    assert duration_score(202_000, {}) == 0.5  # unknown → neutral
    assert duration_score(0, ytm_item()) == 0.5


# ── scoring ───────────────────────────────────────────────────────────────


def test_perfect_match_scores_high():
    score = score_candidate(sp_track(), ytm_item())
    assert score >= MATCHED_THRESHOLD, score


def test_wrong_title_scores_zero():
    score = score_candidate(sp_track(), ytm_item(title="Completely Different Song"))
    assert score == 0.0


def test_wrong_artist_drops_to_approximate_band():
    score = score_candidate(sp_track(), ytm_item(artists=("Leonard Cohen",)))
    assert APPROXIMATE_THRESHOLD <= score < MATCHED_THRESHOLD, score


def test_remastered_title_still_matches():
    score = score_candidate(
        sp_track(title="Bohemian Rhapsody - Remastered 2011", artists=("Queen",), duration_ms=355_000),
        ytm_item(title="Bohemian Rhapsody", artists=("Queen",), duration="5:55"),
    )
    assert score >= MATCHED_THRESHOLD, score


def test_status_thresholds():
    assert status_for_score(0.95) == "matched"
    assert status_for_score(MATCHED_THRESHOLD) == "matched"
    assert status_for_score(0.6) == "approximate"
    assert status_for_score(APPROXIMATE_THRESHOLD) == "approximate"
    assert status_for_score(0.2) == "not_found"


# ── match_track selection ─────────────────────────────────────────────────


def test_match_track_picks_best_candidate():
    queries = []

    def search(query):
        queries.append(query)
        return [
            ytm_item(title="Blinding Lights (Cover)", artists=("Someone Else",), duration="3:30"),
            ytm_item(title="Blinding Lights", artists=("The Weeknd",), duration="3:22"),
        ]

    result = match_track(sp_track(), search)
    assert result.status == "matched"
    assert result.match["artists"] == [{"name": "The Weeknd"}]
    assert result.confidence >= MATCHED_THRESHOLD
    # One query was enough — no title-only fallback needed.
    assert queries == ["Blinding Lights The Weeknd"]


def test_match_track_falls_back_to_title_only_query():
    queries = []

    def search(query):
        queries.append(query)
        if "The Weeknd" in query:
            return [ytm_item(title="Unrelated Song", artists=("Nobody",))]
        return [ytm_item(title="Blinding Lights", artists=("The Weeknd",), duration="3:22")]

    result = match_track(sp_track(), search)
    assert result.status == "matched"
    assert queries == ["Blinding Lights The Weeknd", "Blinding Lights"]


def test_match_track_not_found_when_nothing_close():
    def search(query):
        return [ytm_item(title="Totally Different", artists=("Nobody",))]

    result = match_track(sp_track(), search)
    assert result.status == "not_found"
    assert result.match is None
    assert result.confidence < APPROXIMATE_THRESHOLD


def test_match_track_survives_search_errors():
    def search(query):
        raise RuntimeError("ytm exploded")

    result = match_track(sp_track(), search)
    assert result.status == "not_found"
    assert result.match is None


# ── accuracy: collaborations, versions, query cascade ─────────────────────


def test_normalize_strips_bare_feat_suffix():
    assert normalize_text("Levitating feat. Dua Lipa") == "levitating"
    assert normalize_text("Song ft. Someone") == "song"
    assert normalize_text("Song featuring Someone Else") == "song"


def test_similarity_token_containment_fast_lane():
    # "Single" suffix is the same song, not a coincidence.
    assert similarity("Blinding Lights", "Blinding Lights - Single") >= 0.90


def test_similarity_no_containment_for_single_token_titles():
    # "Up" inside "Stand Up" must NOT fast-lane.
    assert similarity("Up", "Stand Up") < 0.90


def test_artist_similarity_collaboration_overlap():
    item = ytm_item(artists=("KAROL G",))
    score = artist_similarity(["KAROL G", "Judeline", "rusowsky"], item)
    assert score >= 0.60


def test_artist_similarity_split_collaboration_string():
    item = ytm_item(artists=("Shakira, Bizarrap",))
    score = artist_similarity(["Shakira"], item)
    assert score >= 0.60


def test_artist_similarity_no_false_friends():
    assert artist_similarity(["Adele"], ytm_item(artists=("Someone Else",))) < 0.5


def test_score_candidate_prefers_original_over_cover():
    track = sp_track(title="Hallelujah", artists=("Jeff Buckley",), duration_ms=413_000)
    original = ytm_item(title="Hallelujah", artists=("Jeff Buckley",), duration="6:53")
    cover = ytm_item(title="Hallelujah", artists=("Random Cover Artist",), duration="6:53")
    assert score_candidate(track, original) > score_candidate(track, cover)
    assert score_candidate(track, original) >= MATCHED_THRESHOLD


def test_match_track_retries_with_normalized_title():
    queries = []

    def search(query):
        queries.append(query)
        if query.startswith("Bohemian Rhapsody - Remastered"):
            return [ytm_item(title="Some Other Song", artists=("Nobody",))]
        return [ytm_item(title="Bohemian Rhapsody", artists=("Queen",), duration="5:55")]

    track = sp_track(title="Bohemian Rhapsody - Remastered 2011", artists=("Queen",),
                     duration_ms=355_000)
    result = match_track(track, search)
    assert result.status == "matched"
    assert result.match["title"] == "Bohemian Rhapsody"
    assert queries[0] == "Bohemian Rhapsody - Remastered 2011 Queen"
    assert queries[1] == "bohemian rhapsody Queen"


def test_match_track_stops_at_confident_match():
    queries = []

    def search(query):
        queries.append(query)
        return [ytm_item()]

    result = match_track(sp_track(), search)
    assert result.status == "matched"
    # Confident on the first query: no extra searches needed.
    assert queries == ["Blinding Lights The Weeknd"]
