//
//  API.swift
//  Carmen — typed client for the Carmen FastAPI backend.
//
//  No client-side auth exists: every route is a plain GET (all credentials
//  live in the server's browser.json). The base URL is resolved per request
//  from Settings so switching servers applies immediately — same contract as
//  apiBase() on the web client.
//

import Foundation

enum APIError: LocalizedError {
    case unreachable
    case server(status: Int, message: String)
    case notJSON
    case decoding

    var errorDescription: String? {
        switch self {
        case .unreachable:
            return "Cannot reach the server"
        case .server(let status, let message):
            return message.isEmpty ? "Request failed (\(status))" : message
        case .notJSON:
            return "The server answered with a web page — check the Server URL in Settings"
        case .decoding:
            return "The server response could not be read"
        }
    }
}

/// Wrapped `{detail: "…"}` error body the FastAPI backend returns.
private struct APIDetail: Decodable { let detail: String? }

struct API: Sendable {
    var baseURL: URL

    /// Shared session — 30s request timeout, default caching policy.
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 600
        return URLSession(configuration: configuration)
    }()

    init(baseURL: URL) {
        self.baseURL = baseURL
    }

    // MARK: Plumbing

    private func url(_ path: String, _ query: [String: String] = [:]) throws -> URL {
        // String-concat instead of appendingPathComponent: paths start with "/"
        // and the base may carry its own path prefix.
        let base = baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard var components = URLComponents(string: base + path) else {
            throw APIError.unreachable
        }
        if !query.isEmpty {
            components.queryItems =
                query
                .filter { !$0.value.isEmpty }
                .map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else { throw APIError.unreachable }
        return url
    }

    /// GET + JSON decode with HTML-catch-all and `{detail}` error handling.
    func get<T: Decodable>(
        _ path: String, _ query: [String: String] = [:], as type: T.Type = T.self
    ) async throws -> T {
        let requestURL = try url(path, query)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.session.data(from: requestURL)
        } catch let error as URLError where error.code == .cancelled {
            throw error
        } catch {
            throw APIError.unreachable
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.unreachable }

        // The server serves the SPA for unknown paths — catch that before decoding.
        if let mime = http.mimeType, !mime.contains("json"), http.statusCode < 400 {
            throw APIError.notJSON
        }
        if !(200...299).contains(http.statusCode) {
            let detail = (try? JSONDecoder().decode(APIDetail.self, from: data))?.detail ?? ""
            throw APIError.server(status: http.statusCode, message: detail)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding
        }
    }

    // MARK: Endpoints

    /// Rows of the home feed (`{title, contents}` sections).
    func home(limit: Int = 3) async throws -> [HomeSection] {
        try await get("/browsing/home", ["limit": String(limit)])
    }

    /// Flat list of heterogeneous results; `category` on each item labels the
    /// section it belongs to ("Top result", "Songs", "Albums", …).
    func search(_ query: String, limit: Int = 20) async throws -> [MediaCard] {
        try await get("/search", ["query": query, "limit": String(limit)])
    }

    func suggestions(_ query: String) async throws -> [String] {
        try await get("/search/suggestions", ["query": query])
    }

    /// Enriched payload: metadata + duration + lyrics in one call.
    func trackDetail(_ videoId: String, provider: String?) async throws -> TrackDetail {
        var query: [String: String] = [:]
        if let provider, provider != "auto" { query["provider"] = provider }
        return try await get("/browsing/track/\(videoId)", query)
    }

    func related(_ videoId: String, limit: Int = 25) async throws -> [Track] {
        try await get("/browsing/related/\(videoId)", ["limit": String(limit)], as: TrackListPayload.self)
            .tracks
    }

    func album(_ browseId: String) async throws -> AlbumDetail {
        try await get("/browsing/album/\(browseId)")
    }

    func playlist(_ playlistId: String, limit: Int = 100) async throws -> PlaylistDetail {
        try await get("/playlists/\(playlistId)", ["limit": String(limit)])
    }

    func artist(_ channelId: String) async throws -> ArtistDetail {
        try await get("/browsing/artist/\(channelId)")
    }

    /// `/watch` — builds a queue from a song (optionally YouTube's radio
    /// station around it) or a playlist.
    func watch(
        videoId: String? = nil, playlistId: String? = nil,
        radio: Bool = false, limit: Int = 50
    ) async throws -> [Track] {
        var query: [String: String] = ["limit": String(limit)]
        query["videoId"] = videoId
        query["playlistId"] = playlistId
        if radio { query["radio"] = "true" }
        return try await get("/watch", query, as: TrackListPayload.self).tracks
    }

    /// The audio proxy — AVPlayer points straight at this; Range requests and
    /// seeking are supported server-side, upstream URLs never leave the server.
    func streamURL(videoId: String) -> URL? {
        guard let url = try? url("/stream", ["vidId": videoId]) else { return nil }
        return url
    }

    /// Probe the stream with a 2-byte range to surface the server's `detail`
    /// message when a track fails to start (same trick as PlayerContext.tsx).
    func streamError(videoId: String) async -> String? {
        guard let url = try? url("/stream", ["vidId": videoId]) else { return nil }
        var request = URLRequest(url: url)
        request.setValue("bytes=0-1", forHTTPHeaderField: "Range")
        guard let (data, response) = try? await Self.session.data(for: request) else { return nil }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode), !data.isEmpty {
            struct Detail: Decodable { let detail: String? }
            if let detail = (try? JSONDecoder().decode(Detail.self, from: data))?.detail, !detail.isEmpty {
                return detail
            }
        }
        return nil
    }
}
