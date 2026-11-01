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

    /// Shared session — 45s idle-request timeout (the server does real work
    /// per request: yt-dlp URL resolution and lyric-provider lookups can
    /// take tens of seconds on a cold cache), 600s resource timeout.
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 45
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
    /// Transient timeouts get exactly one retry — cold servers resolve
    /// streams / lyrics slowly, and one stuck request should not read as
    /// "Carmen is broken".
    func get<T: Decodable>(
        _ path: String, _ query: [String: String] = [:], as type: T.Type = T.self
    ) async throws -> T {
        do {
            return try await attempt(path, query)
        } catch let error as URLError where error.code == .timedOut {
            DebugLog.log("api", "\(path) timed out — retrying once")
            try? await Task.sleep(for: .milliseconds(750))
            return try await attempt(path, query)
        }
    }

    private func attempt<T: Decodable>(
        _ path: String, _ query: [String: String]
    ) async throws -> T {
        let started = Date()
        let requestURL = try url(path, query)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.session.data(from: requestURL)
        } catch let error as URLError where error.code == .cancelled {
            throw error
        } catch let error as URLError where error.code == .timedOut {
            DebugLog.log("api", "GET \(path) → timeout after \(Self.elapsed(started))s")
            throw error
        } catch {
            DebugLog.log("api", "GET \(path) → unreachable: \(error.localizedDescription)")
            throw APIError.unreachable
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.unreachable }
        DebugLog.log("api", "GET \(path) → \(http.statusCode) in \(Self.elapsed(started))s")

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
            DebugLog.log("api", "GET \(path) → undecodable payload")
            throw APIError.decoding
        }
    }

    private static func elapsed(_ started: Date) -> String {
        String(format: "%.2f", Date().timeIntervalSince(started))
    }

    // MARK: Endpoints

    /// Rows of the home feed (`{title, contents}` sections).
    func home(limit: Int = 3) async throws -> [HomeSection] {
        try await get("/browsing/home", ["limit": String(limit)])
    }

    /// Flat list of heterogeneous results; `category` on each item labels the
    /// section it belongs to ("Top result", "Songs", "Albums", …). `filter`
    /// narrows the backend to one type — `songs`, `videos`, `albums`,
    /// `artists`, `playlists` (nil/"" = everything, like `?filter=all`).
    func search(_ query: String, filter: String? = nil, limit: Int = 100) async throws -> [MediaCard] {
        var params: [String: String] = ["query": query, "limit": String(limit)]
        if let filter, !filter.isEmpty, filter != "all" {
            params["filter"] = filter
        }
        return try await get("/search", params)
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

    /// A podcast show — `/podcasts/podcast/{playlistId}` returns the show's
    /// metadata plus its episodes (each decodes as a `Track`).
    func podcast(_ playlistId: String, limit: Int = 100) async throws -> PodcastDetail {
        try await get("/podcasts/podcast/\(playlistId)", ["limit": String(limit)])
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

    /// Same stream, but on the `carmen-cache` scheme so AVPlayer routes it
    /// through the local disk cache (`StreamResourceLoader`). The loader
    /// rewrites the scheme back to https when it actually fetches.
    func cachedStreamURL(videoId: String) -> URL? {
        guard let remote = streamURL(videoId: videoId) else { return nil }
        var components = URLComponents(url: remote, resolvingAgainstBaseURL: false)
        components?.scheme = StreamResourceLoader.scheme
        return components?.url
    }

    // MARK: Motion (animated) artwork — the same Apple catalogue chain the
    // web client walks: YT Music album → iTunes collection → motion mp4.

    /// `{collection_id: Int?}` — iTunes collection id of a `MPRE…` album.
    func itunesId(_ albumId: String) async throws -> Int? {
        struct Payload: Decodable { let collection_id: Int? }
        let payload: Payload = try await get("/browsing/itunes-id/\(albumId)")
        return payload.collection_id
    }

    /// `{collection_id: Int?}` — flat "Title - Artist" lookup for tracks whose
    /// payload carries no album browse id.
    func itunesId(term: String, entity: String = "song") async throws -> Int? {
        struct Payload: Decodable { let collection_id: Int? }
        let payload: Payload = try await get("/browsing/itunes-id", ["term": term, "entity": entity])
        return payload.collection_id
    }

    /// `{video_url: String?}` — direct mp4 of an album's motion artwork.
    func animatedArtwork(_ collectionId: Int) async throws -> String? {
        struct Payload: Decodable { let video_url: String? }
        let payload: Payload = try await get("/browsing/animated-artwork/\(collectionId)")
        return payload.video_url
    }

    // MARK: Spotify import — the app's only POST: preview via GET, then the
    // conversion streamed back as Server-Sent Events (a POST rules out
    // EventSource, so the frame reader is hand-rolled like the web client's).

    /// `GET /convert/spotify/playlist` — fast preview: playlist metadata and
    /// its full Spotify track list, no YouTube Music searching.
    func spotifyPlaylist(_ link: String) async throws -> SpotifyPlaylistPreview {
        do {
            return try await get("/convert/spotify/playlist", ["url": link])
        } catch let error as APIError {
            if case .server(let status, let message) = error {
                throw APIError.server(status: status, message: Self.friendlySpotifyError(status, message))
            }
            throw error
        }
    }

    /// `POST /convert/spotify/to-ytmusic` — the server answers
    /// `text/event-stream`: `start`, one `progress` per track in playlist
    /// order, then `done` with the summary. `onProgress` is invoked on the
    /// main actor so views can write their `@State` straight from it.
    func convertSpotifyPlaylist(
        _ link: String,
        limit: Int,
        onProgress: @escaping (SpotifyConvertProgress) -> Void
    ) async throws -> SpotifyConvertOutcome {
        var request = URLRequest(url: try url("/convert/spotify/to-ytmusic"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["url": link, "limit": limit])

        let started = Date()
        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        do {
            (bytes, response) = try await Self.session.bytes(for: request)
        } catch let error as URLError where error.code == .cancelled {
            throw error
        } catch {
            DebugLog.log("api", "POST /convert/spotify/to-ytmusic → unreachable: \(error.localizedDescription)")
            throw APIError.unreachable
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.unreachable }
        DebugLog.log("api", "POST /convert/spotify/to-ytmusic → \(http.statusCode) in \(Self.elapsed(started))s")

        // Failures answer with FastAPI's `{detail}` JSON instead of the stream.
        if !(200...299).contains(http.statusCode) {
            var body = ""
            for try await line in bytes.lines { body += line + "\n" }
            let object = (try? JSONSerialization.jsonObject(with: Data(body.utf8))) as? [String: Any]
            let detail = object?["detail"] as? String ?? ""
            DebugLog.log("api", "convert → rejected: \(detail.prefix(200))")
            throw APIError.server(
                status: http.statusCode,
                message: Self.friendlySpotifyError(http.statusCode, detail)
            )
        }

        var playlist: SpotifyPlaylistHead?
        var results: [SpotifyTrackConversion] = []
        var summary: SpotifyConvertSummary?
        var eventName = ""
        var dataLines: [String] = []
        let decoder = JSONDecoder()

        for try await line in bytes.lines {
            if line.isEmpty {
                // Blank line = dispatch the accumulated frame.
                let name = eventName
                let payload = Data(dataLines.joined(separator: "\n").utf8)
                eventName = ""
                dataLines = []
                guard !payload.isEmpty else { continue }
                switch name {
                case "start":
                    playlist = (try? decoder.decode(SpotifyStartEvent.self, from: payload))?.playlist
                case "progress":
                    if let event = try? decoder.decode(SpotifyProgressEvent.self, from: payload) {
                        results.append(event.result)
                        let update = SpotifyConvertProgress(
                            done: event.done, total: event.total, result: event.result
                        )
                        await MainActor.run { onProgress(update) }
                    }
                case "done":
                    summary = (try? decoder.decode(SpotifyDoneEvent.self, from: payload))?.summary
                default:
                    break   // `:` comments and unknown events are ignored
                }
            } else if line.hasPrefix("event:") {
                eventName = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
            }
        }

        if let playlist, let summary {
            DebugLog.log("api", "convert → \(results.count) results (\(summary.matched) matched)")
            return SpotifyConvertOutcome(playlist: playlist, results: results, summary: summary)
        }
        DebugLog.log("api", "convert → stream ended without a done event")
        throw APIError.decoding
    }

    /// Port of the web client's `friendlyConvertError`: Spotify/server status
    /// codes read as sentences, not HTTP.
    private static func friendlySpotifyError(_ status: Int, _ detail: String) -> String {
        if status == 404, detail.contains("/convert/") {
            return "This Carmen server is too old for Spotify import — update the server and try again."
        }
        if status == 404 {
            return "Spotify couldn't find that playlist — it may be private, deleted, or the link is wrong."
        }
        if status == 400 {
            return detail.isEmpty ? "That doesn't look like a Spotify playlist link." : detail
        }
        if status == 503 {
            return "Spotify is busy right now — try again in a minute."
        }
        return detail.isEmpty ? "Conversion failed (\(status))." : detail
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
