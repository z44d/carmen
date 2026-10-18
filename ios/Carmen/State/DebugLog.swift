//
//  DebugLog.swift
//  Carmen — append-only diagnostic log.
//
//  Every layer that can fail (API calls, stream loader, player transitions,
//  downloads, motion artwork) writes a timestamped line here so a user can
//  export the file from Settings → Diagnostics and show the real reason a
//  song refused to play. Writes are cheap (one line on a serial queue) and
//  the file is rotated past ~2 MB so it can never eat the disk.
//

import Foundation

enum DebugLog {
    /// Rotated once past this size — one previous generation is kept.
    private static let sizeCap: Int64 = 2_000_000

    private static let queue = DispatchQueue(label: "carmen.debuglog")
    private static let fileManager = FileManager.default

    /// App-group-free location: Caches/Logs/carmen.log.
    nonisolated static var fileURL: URL {
        let caches = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        return caches
            .appendingPathComponent("logs", isDirectory: true)
            .appendingPathComponent("carmen.log")
    }

    private static var oldFileURL: URL {
        fileURL.appendingPathExtension("1")
    }

    /// One line: `2026-10-17 12:34:56.789 [player] message`.
    /// All file + formatter access happens on the serial queue (DateFormatter
    /// is not thread-safe), so this stays callable from any thread.
    nonisolated static func log(_ category: String, _ message: @autoclosure () -> String) {
        let line = message()
        queue.async {
            let url = fileURL
            try? fileManager.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            if !fileManager.fileExists(atPath: url.path) {
                fileManager.createFile(atPath: url.path, contents: nil)
                rotateLocked()
            }
            guard let handle = try? FileHandle(forWritingTo: url) else { return }
            defer { try? handle.close() }
            try? handle.seekToEnd()
            let stamp = timestampFormatter.string(from: Date())
            try? handle.write(contentsOf: Data("[\(stamp)] [\(category)] \(line)\n".utf8))
        }
    }

    /// Size of the current log file, human-readable (Settings → Diagnostics).
    nonisolated static var sizeLabel: String {
        let bytes = (try? fileURL.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        return ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    /// Wipe the log (and its rotation) — the Diagnostics section's Clear row.
    nonisolated static func clear() {
        queue.async {
            try? fileManager.removeItem(at: fileURL)
            try? fileManager.removeItem(at: oldFileURL)
        }
    }

    /// DateFormatter is not thread-safe — only touch it on `queue`.
    private static let timestampFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        return formatter
    }()

    /// Rotate once past the cap: current file becomes `carmen.log.1`.
    /// Call with `queue` held.
    private static func rotateLocked() {
        let url = fileURL
        guard let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize,
            Int64(size) > sizeCap
        else { return }
        try? fileManager.removeItem(at: oldFileURL)
        try? fileManager.moveItem(at: url, to: oldFileURL)
    }
}
