//
//  Downloads.swift
//  Carmen — offline downloads.
//
//  One folder per song under Documents/songs/<videoId>/ holding exactly what
//  the web client saves: the raw `audio.*`, the best artwork it can get, the
//  enriched `track.json` payload (the offline source of truth) plus
//  human-readable `lyrics.lrc` / `lyrics.txt`. Downloaded audio plays
//  straight from disk (Player picks it before any stream), so a song on the
//  device never touches the network again.
//

import Foundation
import Observation

@MainActor
@Observable
final class DownloadsStore {
    static let shared = DownloadsStore()

    /// Per-song button state: a progress ring while fetching, a check when
    /// (or after) the song is saved.
    enum State: Equatable, Sendable {
        case running(progress: Double)
        case done
    }

    /// Songs with a complete `audio.*` file on disk.
    private(set) var downloadedIds: Set<String> = []
    /// In-flight / just-finished download states driving the buttons.
    private(set) var states: [String: State] = [:]
    /// Video ids whose last attempt failed (until the alert is dismissed).
    private(set) var failedIds: Set<String> = []

    @ObservationIgnored private let fileManager = FileManager.default
    @ObservationIgnored private var tasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var trackCache: [String: Track] = [:]

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 1_800
        return URLSession(configuration: configuration)
    }()

    private init() {
        scan()
    }

    // MARK: - Locations

    private var root: URL {
        fileManager.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("songs", isDirectory: true)
    }

    func directory(for videoId: String) -> URL {
        root.appendingPathComponent(videoId, isDirectory: true)
    }

    /// `audio.<ext>` of a downloaded song (nil while not downloaded).
    func audioURL(videoId: String) -> URL? { firstFile(prefix: "audio", videoId: videoId) }

    /// `artwork.<ext>` of a downloaded song.
    func artworkURL(videoId: String) -> URL? { firstFile(prefix: "artwork", videoId: videoId) }

    private func firstFile(prefix: String, videoId: String) -> URL? {
        let dir = directory(for: videoId)
        let names = (try? fileManager.contentsOfDirectory(atPath: dir.path)) ?? []
        guard let name = names.first(where: { $0.hasPrefix(prefix + ".") }) else { return nil }
        return dir.appendingPathComponent(name)
    }

    // MARK: - Queries

    func isDownloaded(_ videoId: String) -> Bool { downloadedIds.contains(videoId) }

    func state(for videoId: String) -> State? { states[videoId] }

    /// Decoded `track.json` (cached) — lyrics + metadata for offline display.
    func detail(videoId: String) -> TrackDetail? {
        let path = directory(for: videoId).appendingPathComponent("track.json")
        guard let data = try? Data(contentsOf: path),
            let detail = try? JSONDecoder().decode(TrackDetail.self, from: data)
        else { return nil }
        return detail
    }

    /// Every downloaded song, newest first.
    func downloadedTracks() -> [Track] {
        downloadedIds
            .sorted { modifiedAt($0) > modifiedAt($1) }
            .compactMap { track(for: $0) }
    }

    /// The persisted `Track` of a download (from its `track.json`).
    func track(for videoId: String) -> Track? {
        if let cached = trackCache[videoId] { return cached }
        guard let track = detail(videoId: videoId)?.track else { return nil }
        trackCache[videoId] = track
        return track
    }

    private func modifiedAt(_ videoId: String) -> Date {
        let dir = directory(for: videoId)
        let values = try? dir.resourceValues(forKeys: [.contentModificationDateKey])
        return values?.contentModificationDate ?? .distantPast
    }

    /// Total bytes on disk (audio + artwork + payloads).
    var totalBytes: Int64 {
        var total: Int64 = 0
        for id in downloadedIds {
            let dir = directory(for: id)
            let names = (try? fileManager.contentsOfDirectory(atPath: dir.path)) ?? []
            for name in names {
                let file = dir.appendingPathComponent(name)
                let values = try? file.resourceValues(forKeys: [.fileSizeKey])
                total += Int64(values?.fileSize ?? 0)
            }
        }
        return total
    }

    var totalSizeLabel: String {
        ByteCountFormatter.string(fromByteCount: totalBytes, countStyle: .file)
    }

    // MARK: - Downloading

    /// Download audio + artwork + `track.json`/lyrics for one song.
    func download(_ track: Track) {
        let id = track.videoId
        guard !downloadedIds.contains(id), tasks[id] == nil else { return }
        failedIds.remove(id)
        states[id] = .running(progress: 0)
        tasks[id] = Task { [weak self] in
            guard let self else { return }
            await self.perform(track)
            self.tasks[id] = nil
        }
    }

    /// Dismiss the failure flag behind a download alert.
    func acknowledgeFailure(_ videoId: String) {
        failedIds.remove(videoId)
    }

    /// Toggle helper for menus: forget a saved song.
    func remove(videoId: String) {
        tasks[videoId]?.cancel()
        tasks[videoId] = nil
        try? fileManager.removeItem(at: directory(for: videoId))
        downloadedIds.remove(videoId)
        trackCache[videoId] = nil
        states[videoId] = nil
        failedIds.remove(videoId)
    }

    func removeAll() {
        for id in downloadedIds { remove(videoId: id) }
    }

    private func perform(_ track: Track) async {
        let id = track.videoId
        let api = API(baseURL: SettingsStore.shared.apiBaseURL)
        do {
            // 1. Audio — the only required piece; written atomically once the
            //    whole body arrived so a failure never leaves a fake download.
            guard let stream = api.streamURL(videoId: id) else { throw APIError.unreachable }
            let (audio, mime) = try await fetchAudio(stream, videoId: id)
            let dir = directory(for: id)
            try? fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
            try audio.write(to: dir.appendingPathComponent("audio.\(Self.audioExtension(mime))"), options: .atomic)

            // 2. Artwork — best effort (ytimg chain first, payload fallbacks).
            if let (image, ext) = await Self.fetchArtwork(track) {
                try? image.write(to: dir.appendingPathComponent("artwork.\(ext)"), options: .atomic)
            }

            // 3. Enriched payload + lyrics — the offline source of truth.
            if let detail = try? await api.trackDetail(id, provider: nil),
                let payload = try? JSONEncoder().encode(detail)
            {
                try? payload.write(to: dir.appendingPathComponent("track.json"), options: .atomic)
                Self.writeLyrics(detail.lyrics, into: dir)
            }

            trackCache[id] = track
            downloadedIds.insert(id)
            states[id] = .done
        } catch is CancellationError {
            try? fileManager.removeItem(at: directory(for: id))
            states[id] = nil
        } catch {
            try? fileManager.removeItem(at: directory(for: id))
            states[id] = nil
            failedIds.insert(id)
        }
    }

    private func fetchAudio(_ url: URL, videoId: String) async throws -> (Data, String?) {
        let (bytes, response) = try await Self.session.bytes(for: URLRequest(url: url))
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw APIError.server(status: status, message: "")
        }
        let expected = http.expectedContentLength > 0 ? http.expectedContentLength : 0
        var data = Data()
        var lastReported = 0.0
        for try await chunk in bytes {
            data.append(chunk)
            if expected > 0 {
                let progress = min(Double(data.count) / Double(expected), 1)
                if progress - lastReported >= 0.02 {  // throttle observation churn
                    lastReported = progress
                    states[videoId] = .running(progress: progress)
                }
            }
        }
        return (data, http.mimeType)
    }

    // MARK: Artwork / lyrics helpers

    /// Best square-ish cover: ytimg chain first (same order as the web
    /// client), then whatever the payload carried.
    private static func fetchArtwork(_ track: Track) async -> (Data, String)? {
        var candidates = [
            "https://i.ytimg.com/vi/\(track.videoId)/maxresdefault.jpg",
            "https://i.ytimg.com/vi/\(track.videoId)/sddefault.jpg",
            "https://i.ytimg.com/vi/\(track.videoId)/hqdefault.jpg",
        ]
        candidates.append(contentsOf: [track.artwork, track.artworkAlt].compactMap { $0 })

        var seen = Set<String>()
        for candidate in candidates where seen.insert(candidate).inserted {
            guard let url = URL(string: candidate) else { continue }
            guard let (data, response) = try? await session.data(from: url),
                (response as? HTTPURLResponse)?.statusCode == 200, !data.isEmpty
            else { continue }
            let mime = (response as? HTTPURLResponse)?.mimeType ?? "image/jpeg"
            return (data, imageExtension(mime))
        }
        return nil
    }

    private static func imageExtension(_ mime: String) -> String {
        switch mime.split(separator: ";").first.map(String.init) {
        case "image/png": return "png"
        case "image/webp": return "webp"
        default: return "jpg"
        }
    }

    private static func audioExtension(_ mime: String?) -> String {
        switch mime?.split(separator: ";").first.map(String.init) {
        case "audio/mp4", "audio/aac", "video/mp4": return "m4a"
        case "audio/webm", "audio/opus": return "webm"
        case "audio/mpeg", "audio/mp3": return "mp3"
        case "audio/ogg", "application/ogg": return "ogg"
        default: return "mp4"
        }
    }

    /// `lyrics.lrc` from timed lines + `lyrics.txt` from plain text.
    private static func writeLyrics(_ lyrics: Lyrics?, into directory: URL) {
        guard let lyrics else { return }
        if let synced = lyrics.synced, !synced.isEmpty {
            let lrc = synced
                .map { line -> String in
                    let totalSeconds = max(line.timeMs, 0) / 1000
                    let stamp = String(
                        format: "[%02d:%02d.%02d]",
                        totalSeconds / 60,
                        totalSeconds % 60,
                        (max(line.timeMs, 0) % 1000) / 10
                    )
                    return stamp + line.text
                }
                .joined(separator: "\n")
            try? lrc.write(
                to: directory.appendingPathComponent("lyrics.lrc"),
                atomically: true,
                encoding: .utf8
            )
        }
        if let plain = lyrics.plainText {
            try? plain.write(
                to: directory.appendingPathComponent("lyrics.txt"),
                atomically: true,
                encoding: .utf8
            )
        }
    }

    // MARK: Scan

    /// Rebuild `downloadedIds` from disk (launch).
    private func scan() {
        try? fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        let names = (try? fileManager.contentsOfDirectory(atPath: root.path)) ?? []
        var found = Set<String>()
        for name in names {
            let audio = firstFile(prefix: "audio", videoId: name)
            if audio != nil { found.insert(name) }
        }
        downloadedIds = found
    }
}
