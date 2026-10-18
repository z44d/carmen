//
//  Downloads.swift
//  Carmen — offline downloads over a background URLSession.
//
//  One folder per song under Documents/songs/<videoId>/ holding exactly what
//  the web client saves: the raw `audio.*`, the best artwork it can get, the
//  enriched `track.json` payload (the offline source of truth) plus
//  human-readable `lyrics.lrc` / `lyrics.txt`. Downloaded audio plays
//  straight from disk (Player picks it before any stream), so a song on the
//  device never touches the network again.
//
//  The audio itself transfers through a *background* URLSession, so it keeps
//  going while the app is suspended or killed; iOS relaunches the process to
//  deliver the finished file (handleEventsForBackgroundURLSession in
//  CarmenApp). Byte progress drives both the button's ring and the download
//  Live Activity (State/DownloadActivity.swift).
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

    /// Handed over when iOS relaunches the app for the background session.
    var backgroundCompletionHandler: (() -> Void)?

    @ObservationIgnored private let fileManager = FileManager.default
    @ObservationIgnored private let delegate = DownloadSessionDelegate()
    @ObservationIgnored private let backgroundSession: URLSession
    @ObservationIgnored private var downloadTasks: [String: URLSessionDownloadTask] = [:]
    @ObservationIgnored private var trackCache: [String: Track] = [:]
    @ObservationIgnored private var lastProgressReport: [String: (progress: Double, date: Date)] = [:]
    /// Tracks of in-flight downloads — persisted so a relaunch mid-download
    /// can still name the song on its Live Activity.
    @ObservationIgnored private var activeTracks: [String: Track] = [:]

    private static let activeTracksKey = "downloads.activeTracks"

    /// Companion fetches (artwork, track.json) — the audio goes through the
    /// background session instead.
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 1_800
        return URLSession(configuration: configuration)
    }()

    private init() {
        // Created first: if iOS relaunched us for the session's events the
        // delegate must already be attached when they arrive.
        let configuration = URLSessionConfiguration.background(
            withIdentifier: "com.z44d.carmen.downloads"
        )
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        backgroundSession = URLSession(
            configuration: configuration,
            delegate: delegate,
            delegateQueue: nil
        )
        scan()
        restoreActiveTracks()
    }

    // MARK: - Locations

    nonisolated static var songsRoot: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("songs", isDirectory: true)
    }

    private var root: URL { Self.songsRoot }

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

    /// Start saving one song: the audio through the background session (it
    /// outlives the app), artwork + `track.json` once the bytes landed.
    func download(_ track: Track) {
        let id = track.videoId
        guard !downloadedIds.contains(id), downloadTasks[id] == nil else { return }
        failedIds.remove(id)
        guard let url = API(baseURL: SettingsStore.shared.apiBaseURL).streamURL(videoId: id) else {
            DebugLog.log("downloads", "failed \(id): no stream url")
            failedIds.insert(id)
            return
        }
        states[id] = .running(progress: 0)
        activeTracks[id] = track
        persistActiveTracks()

        let task = backgroundSession.downloadTask(with: URLRequest(url: url))
        task.taskDescription = id
        downloadTasks[id] = task
        task.resume()
        DebugLog.log("downloads", "started \(id)")
        DownloadActivityController.shared.start(track: track, videoId: id)
    }

    /// Dismiss the failure flag behind a download alert.
    func acknowledgeFailure(_ videoId: String) {
        failedIds.remove(videoId)
    }

    /// Toggle helper for menus: forget a saved song.
    func remove(videoId: String) {
        downloadTasks[videoId]?.cancel()
        downloadTasks[videoId] = nil
        try? fileManager.removeItem(at: directory(for: videoId))
        downloadedIds.remove(videoId)
        trackCache[videoId] = nil
        states[videoId] = nil
        failedIds.remove(videoId)
        activeTracks[videoId] = nil
        persistActiveTracks()
        lastProgressReport[videoId] = nil
        DownloadActivityController.shared.dismiss(videoId: videoId)
    }

    func removeAll() {
        for id in downloadedIds { remove(videoId: id) }
    }

    // MARK: - Background-session callbacks (hop from the delegate)

    /// Byte progress — throttled to ~2% steps so the ring and the Live
    /// Activity update without churning observation.
    nonisolated func reportProgress(videoId: String, written: Int64, expected: Int64) {
        Task { @MainActor in
            guard self.states[videoId] != nil || self.activeTracks[videoId] != nil else { return }
            let progress = expected > 0 ? min(Double(written) / Double(expected), 1) : 0
            let now = Date()
            if let last = self.lastProgressReport[videoId] {
                guard progress - last.progress >= 0.02 || now.timeIntervalSince(last.date) > 2 else {
                    return
                }
            }
            self.lastProgressReport[videoId] = (progress, now)
            self.states[videoId] = .running(progress: progress)
            DebugLog.log(
                "downloads",
                "progress \(videoId): \(written)/\(expected) (\(Int(progress * 100))%)"
            )
            DownloadActivityController.shared.update(
                videoId: videoId,
                progress: progress,
                received: written,
                total: expected
            )
        }
    }

    /// The audio finished transferring — stage the file, then fetch the
    /// companions (artwork, track.json) and mark the song saved.
    nonisolated func downloadAudioReady(videoId: String, staged: URL) {
        Task { @MainActor in
            self.downloadTasks[videoId] = nil
            guard let track = self.activeTracks[videoId] ?? self.trackCache[videoId] else {
                self.downloadFailed(videoId: videoId, reason: "lost track metadata")
                return
            }
            self.finalize(track, staged: staged)
        }
    }

    nonisolated func downloadFailed(videoId: String, reason: String) {
        Task { @MainActor in
            self.downloadTasks[videoId] = nil
            guard self.states[videoId] != nil || self.activeTracks[videoId] != nil else { return }
            DebugLog.log("downloads", "failed \(videoId): \(reason)")
            try? self.fileManager.removeItem(at: self.directory(for: videoId))
            self.states[videoId] = nil
            self.activeTracks[videoId] = nil
            self.persistActiveTracks()
            self.lastProgressReport[videoId] = nil
            self.failedIds.insert(videoId)
            DownloadActivityController.shared.end(videoId: videoId, failed: true)
        }
    }

    /// Cancelled through `remove` — the cleanup already happened there.
    nonisolated func downloadCancelled(videoId: String) {
        Task { @MainActor in
            self.downloadTasks[videoId] = nil
            self.states[videoId] = nil
            self.activeTracks[videoId] = nil
            self.persistActiveTracks()
        }
    }

    /// Called by the AppDelegate once the relaunched session drained its
    /// pending events — lets iOS know the relaunch is done.
    func runBackgroundCompletionHandler() {
        backgroundCompletionHandler?()
        backgroundCompletionHandler = nil
    }

    // MARK: - Post-transfer work

    private func finalize(_ track: Track, staged: URL) {
        let id = track.videoId
        let api = API(baseURL: SettingsStore.shared.apiBaseURL)
        Task {
            // 1. Artwork — best effort (ytimg chain first, payload fallbacks).
            if let (image, ext) = await Self.fetchArtwork(track) {
                try? image.write(
                    to: directory(for: id).appendingPathComponent("artwork.\(ext)"),
                    options: .atomic
                )
            }

            // 2. Enriched payload + lyrics — the offline source of truth.
            if let detail = try? await api.trackDetail(id, provider: nil),
                let payload = try? JSONEncoder().encode(detail)
            {
                try? payload.write(
                    to: directory(for: id).appendingPathComponent("track.json"),
                    options: .atomic
                )
                Self.writeLyrics(detail.lyrics, into: directory(for: id))
            }

            trackCache[id] = track
            downloadedIds.insert(id)
            states[id] = .done
            activeTracks[id] = nil
            persistActiveTracks()
            lastProgressReport[id] = nil
            DebugLog.log("downloads", "finished \(id)")
            DownloadActivityController.shared.end(videoId: id, failed: false)
        }
    }

    /// Move the temp file the system hands to the delegate into its final
    /// home — must run synchronously, before the delegate method returns
    /// (the system deletes the temp file right after).
    nonisolated static func stageAudioFile(at location: URL, videoId: String, mime: String?) -> URL? {
        let dir = songsRoot.appendingPathComponent(videoId, isDirectory: true)
        let fileManager = FileManager.default
        try? fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
        let destination = dir.appendingPathComponent("audio.\(audioExtension(mime))")
        try? fileManager.removeItem(at: destination)
        do {
            try fileManager.moveItem(at: location, to: destination)
            return destination
        } catch {
            DebugLog.log("downloads", "stage failed \(videoId): \(error.localizedDescription)")
            return nil
        }
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

    nonisolated static func audioExtension(_ mime: String?) -> String {
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

    // MARK: Persistence

    private func persistActiveTracks() {
        guard let data = try? JSONEncoder().encode(activeTracks) else { return }
        UserDefaults.standard.set(data, forKey: Self.activeTracksKey)
    }

    private func restoreActiveTracks() {
        guard let data = UserDefaults.standard.data(forKey: Self.activeTracksKey),
            let saved = try? JSONDecoder().decode([String: Track].self, from: data)
        else { return }
        activeTracks = saved
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

/// Delegate for the background download session. Nonisolated (URLSession
/// calls in on its own queue) — every store interaction hops to the main
/// actor. The file move in `didFinishDownloadingTo` is the one synchronous
/// piece: the system deletes the temp file the moment this returns.
final class DownloadSessionDelegate: NSObject, URLSessionDownloadDelegate {
    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        guard let id = downloadTask.taskDescription else { return }
        let http = downloadTask.response as? HTTPURLResponse
        let status = http?.statusCode ?? 200
        guard (200...299).contains(status) else {
            DownloadsStore.shared.downloadFailed(
                videoId: id,
                reason: "server responded \(status)"
            )
            return
        }
        guard
            let staged = DownloadsStore.stageAudioFile(
                at: location,
                videoId: id,
                mime: http?.mimeType
            )
        else {
            DownloadsStore.shared.downloadFailed(
                videoId: id,
                reason: "could not move the file into place"
            )
            return
        }
        DownloadsStore.shared.downloadAudioReady(videoId: id, staged: staged)
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        guard let id = downloadTask.taskDescription else { return }
        DownloadsStore.shared.reportProgress(
            videoId: id,
            written: totalBytesWritten,
            expected: totalBytesExpectedToWrite
        )
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        guard let error, let id = task.taskDescription else { return }
        if (error as? URLError)?.code == .cancelled {
            DownloadsStore.shared.downloadCancelled(videoId: id)
            return
        }
        DownloadsStore.shared.downloadFailed(videoId: id, reason: error.localizedDescription)
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        Task { @MainActor in
            DownloadsStore.shared.runBackgroundCompletionHandler()
        }
    }
}
