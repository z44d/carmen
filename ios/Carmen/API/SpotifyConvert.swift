//
//  SpotifyConvert.swift
//  Carmen — wire types for the server's Spotify → YouTube Music converter
//  (GET /convert/spotify/playlist + POST /convert/spotify/to-ytmusic SSE).
//  Contract-for-contract port of frontend/src/services/spotifyConvert.ts:
//  the server does all the matching, the client only previews, renders
//  progress and writes the selected matches into a local playlist.
//

import Foundation

// MARK: - Link validation (same three shapes the server and web client accept)

enum SpotifyLink {
    /// Playlist id out of a link, `spotify:playlist:` URI or bare 22-char id.
    /// Returns nil for anything else — the UI blocks doomed requests with it.
    static func playlistID(_ input: String) -> String? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        for pattern in [uriPattern, urlPattern, bareIDPattern] {
            if let id = firstCapture(pattern, in: text) { return id }
        }
        return nil
    }

    /// `https?://open.spotify.com/(intl-xx-)?playlist/<22 alnum>` (scheme optional).
    private static let urlPattern =
        "^(?:https?://)?open\\.spotify\\.com/(?:intl-[a-z-]+/)?playlist/([A-Za-z0-9]{22})(?:[?#/].*)?$"
    private static let uriPattern = "^spotify:playlist:([A-Za-z0-9]{22})$"
    private static let bareIDPattern = "^([A-Za-z0-9]{22})$"

    private static func firstCapture(_ pattern: String, in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range),
              match.numberOfRanges > 1, let captured = Range(match.range(at: 1), in: text)
        else { return nil }
        return String(text[captured])
    }
}

// MARK: - Preview (`GET /convert/spotify/playlist`)

/// One Spotify track as the preview endpoint lists it.
struct SpotifyTrackInfo: Decodable, Hashable, Identifiable, Sendable {
    let id: String
    let title: String
    let artists: [String]
    let artist: String
    let album: String
    let artwork: String?
    let durationMs: Int
    let spotifyURL: String
    let explicit: Bool

    private enum CodingKeys: String, CodingKey {
        case id, title, artists, artist, album, artwork, explicit
        case durationMs = "duration_ms"
        case spotifyURL = "spotify_url"
    }
}

/// Playlist metadata + its full Spotify track list — the step before converting.
struct SpotifyPlaylistPreview: Decodable, Hashable, Sendable {
    let id: String
    let name: String
    let description: String
    let owner: String
    let artwork: String?
    let spotifyURL: String
    let trackCount: Int
    let tracks: [SpotifyTrackInfo]

    private enum CodingKeys: String, CodingKey {
        case id, name, description, owner, artwork, tracks
        case spotifyURL = "spotify_url"
        case trackCount = "track_count"
    }

    /// One malformed track must not sink the whole preview — same lenient
    /// array rule the rest of the app applies to mixed payloads.
    private struct Lossy: Decodable {
        let value: SpotifyTrackInfo?
        init(from decoder: Decoder) { value = try? SpotifyTrackInfo(from: decoder) }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        description = (try? container.decode(String.self, forKey: .description)) ?? ""
        owner = (try? container.decode(String.self, forKey: .owner)) ?? ""
        artwork = (try? container.decodeIfPresent(String.self, forKey: .artwork)) ?? nil
        spotifyURL = (try? container.decode(String.self, forKey: .spotifyURL)) ?? ""
        trackCount = (try? container.decode(Int.self, forKey: .trackCount)) ?? 0
        tracks = (try? container.decode([Lossy].self, forKey: .tracks))?.compactMap(\.value) ?? []
    }
}

// MARK: - Conversion (POST /convert/spotify/to-ytmusic SSE)

enum SpotifyMatchStatus: String, Decodable, Sendable {
    case matched
    case approximate
    case notFound = "not_found"
    case error
}

/// One `progress` event's `result` — the Spotify track, how well it matched,
/// and the sanitized YouTube Music search item (`nil` when there is none).
struct SpotifyTrackConversion: Decodable, Hashable, Sendable {
    let spotify: SpotifyTrackInfo
    let status: SpotifyMatchStatus
    let confidence: Double
    let match: Track?
    let error: String?

    private enum CodingKeys: String, CodingKey {
        case spotify, status, confidence, match, error
    }

    /// The server only guarantees `videoId`-bearing matches decode as `Track`;
    /// a broken `match` becomes nil instead of failing the whole stream.
    private struct LossyMatch: Decodable {
        let value: Track?
        init(from decoder: Decoder) { value = try? Track(from: decoder) }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        spotify = try container.decode(SpotifyTrackInfo.self, forKey: .spotify)
        status = (try? container.decode(SpotifyMatchStatus.self, forKey: .status)) ?? .error
        confidence = (try? container.decode(Double.self, forKey: .confidence)) ?? 0
        match = ((try? container.decodeIfPresent(LossyMatch.self, forKey: .match)) ?? nil)?.value
        error = (try? container.decodeIfPresent(String.self, forKey: .error)) ?? nil
    }

    /// Usable rows are the only selectable ones (frontend rule: a match that
    /// is not `not_found` — "Unmatched songs can't be saved").
    var isSelectable: Bool { match != nil && status != .notFound }
}

/// `done` event payload — the honest end-of-run counts.
struct SpotifyConvertSummary: Decodable, Hashable, Sendable {
    let total: Int
    let matched: Int
    let approximate: Int
    let notFound: Int
    let error: Int

    private enum CodingKeys: String, CodingKey {
        case total, matched, approximate, error
        case notFound = "not_found"
    }

    /// Rows that can't be saved (not found + errored).
    var unusable: Int { notFound + error }
}

/// `start` event's playlist head (id/name/owner/artwork).
struct SpotifyPlaylistHead: Decodable, Hashable, Sendable {
    let id: String
    let name: String
    let owner: String
    let artwork: String?
}

/// One `progress` event as the view consumes it.
struct SpotifyConvertProgress: Sendable {
    let done: Int
    let total: Int
    let result: SpotifyTrackConversion
}

/// Everything the flow needs after the stream ends.
struct SpotifyConvertOutcome: Sendable {
    let playlist: SpotifyPlaylistHead
    let results: [SpotifyTrackConversion]
    let summary: SpotifyConvertSummary
}

// MARK: - SSE event payloads (private — the parsing lives in API.swift)

struct SpotifyStartEvent: Decodable {
    let total: Int
    let playlist: SpotifyPlaylistHead
}

struct SpotifyProgressEvent: Decodable {
    let done: Int
    let total: Int
    let result: SpotifyTrackConversion
}

struct SpotifyDoneEvent: Decodable {
    let summary: SpotifyConvertSummary
}
