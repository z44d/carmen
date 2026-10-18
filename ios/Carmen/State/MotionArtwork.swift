//
//  MotionArtwork.swift
//  Carmen — on-disk cache for motion ("animated") artwork mp4s.
//
//  iOS 26's `MPMediaItemAnimatedArtwork` video handler must answer with a
//  *local* file URL and gets roughly 30 seconds to do it, so the mp4 is
//  downloaded ahead of time: Player.prefetchMotion kicks it off the moment a
//  motion URL resolves, and the handler merely re-checks the disk. Files live
//  in Library/Caches/motion; only the newest handful is kept.
//

import CryptoKit
import Foundation

enum MotionArtwork {
    /// How many motion mp4s to keep around (~5–20 MB each).
    private static let keepCount = 12

    /// 30s idle / 180s total: these videos come from Apple's CDN through the
    /// server's lookup, and a cold chain can stall before the first byte.
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 180
        return URLSession(configuration: configuration)
    }()

    /// In-flight downloads, keyed by cache id — the lock-screen handler and
    /// the in-app tile can both ask for the same track at once.
    private static let lock = NSLock()
    private static var inFlight: [String: Task<URL?, Never>] = [:]

    private static var directory: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return caches.appendingPathComponent("motion", isDirectory: true)
    }

    /// Already on disk? The lock-screen handler checks this first — a hit
    /// answers instantly, a miss falls back to the static artwork.
    static func hasLocalFile(urlString: String, id: String) -> Bool {
        FileManager.default.fileExists(atPath: fileURL(urlString: urlString, id: id).path)
    }

    /// Start the download now, answer later — the Player calls this as soon
    /// as a motion URL resolves so the file is ready before playback starts.
    static func prefetch(urlString: String, id: String) {
        _ = localFile(urlString: urlString, id: id)
    }

    /// Local file URL for a motion artwork mp4, downloading it if needed.
    /// Returns nil on any failure — the system then falls back to the static
    /// preview image we provided alongside.
    static func localFile(urlString: String, id: String) async -> URL? {
        let file = fileURL(urlString: urlString, id: id)
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: file.path) { return file }
        guard let remote = URL(string: urlString) else { return nil }

        // Dedupe concurrent asks for the same artwork.
        lock.lock()
        if let existing = inFlight[file.lastPathComponent] {
            lock.unlock()
            return await existing.value
        }
        let task = Task<URL?, Never> { [remote, file] () -> URL? in
            do {
                let (data, response) = try await session.data(from: remote)
                guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
                    !data.isEmpty
                else {
                    DebugLog.log("motion", "download failed (\(http?.statusCode ?? 0)): \(remote.lastPathComponent)")
                    return nil
                }
                try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
                try data.write(to: file, options: .atomic)
                prune()
                DebugLog.log("motion", "saved \(file.lastPathComponent) (\(data.count / 1024) KB)")
                return file
            } catch {
                DebugLog.log("motion", "download error: \(error.localizedDescription)")
                return nil
            }
        }
        inFlight[file.lastPathComponent] = task
        lock.unlock()

        let result = await task.value
        lock.lock()
        inFlight[file.lastPathComponent] = nil
        lock.unlock()
        return result
    }

    /// Cache path for an artwork mp4 (id = anything stable per artwork, e.g.
    /// "motionURL videoId" or the collection id).
    static func fileURL(urlString: String, id: String) -> URL {
        directory.appendingPathComponent(fileName(for: "\(id)|\(urlString)"))
    }

    private static func fileName(for id: String) -> String {
        let digest = SHA256.hash(data: Data(id.utf8)).map { String(format: "%02x", $0) }.joined()
        return String(digest.prefix(24)) + ".mp4"
    }

    /// Drop the oldest copies beyond `keepCount`.
    private static func prune() {
        let fileManager = FileManager.default
        let keys: [URLResourceKey] = [.contentModificationDateKey]
        guard let files = try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: keys
        ) else { return }
        let dated = files.map { url -> (URL, Date) in
            let date = (try? url.resourceValues(forKeys: Set(keys)))?.contentModificationDate ?? .distantPast
            return (url, date)
        }
        for (url, _) in dated.sorted(by: { $0.1 < $1.1 }).prefix(max(0, dated.count - keepCount)) {
            try? fileManager.removeItem(at: url)
        }
    }
}
