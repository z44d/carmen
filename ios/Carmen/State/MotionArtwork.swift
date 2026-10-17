//
//  MotionArtwork.swift
//  Carmen — on-disk cache for motion ("animated") artwork mp4s.
//
//  iOS 26's `MPMediaItemAnimatedArtwork` video handler must answer with a
//  *local* file URL and gets roughly 30 seconds to do it, so the mp4 is
//  downloaded on demand (or reused from an earlier track with the same art).
//  Files live in Library/Caches/motion; only the newest handful is kept.
//

import CryptoKit
import Foundation

enum MotionArtwork {
    /// How many motion mp4s to keep around (~5–20 MB each).
    private static let keepCount = 12

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 60
        return URLSession(configuration: configuration)
    }()

    private static var directory: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return caches.appendingPathComponent("motion", isDirectory: true)
    }

    /// Local file URL for a motion artwork mp4, downloading it if needed.
    /// Returns nil on any failure — the system then falls back to the static
    /// preview image we provided alongside.
    static func localFile(urlString: String, id: String) async -> URL? {
        guard let remote = URL(string: urlString) else { return nil }
        let file = directory.appendingPathComponent(fileName(for: id))
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: file.path) { return file }

        do {
            let (data, response) = try await session.data(from: remote)
            guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode), !data.isEmpty
            else { return nil }
            try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: file, options: .atomic)
            prune()
            return file
        } catch {
            return nil
        }
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
