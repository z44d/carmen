//
//  ArtworkThumbCache.swift
//  Carmen — tiny cover JPEGs shipped *inside* a Live Activity's ContentState.
//
//  The Lock Screen presentation can't be relied on to fetch a remote image
//  (the card is rendered outside the app's network window), which is why the
//  lyric and download cards kept coming up without their thumb. The app
//  downscales the cover once, hands the bytes to the widget in the state
//  itself, and caches them on disk so a later activity starts instantly.
//
//  App target only — the widget never builds a thumb, it only paints one.
//

import Foundation
import UIKit

@MainActor
final class ArtworkThumbCache {
    static let shared = ArtworkThumbCache()

    /// Side of the square thumb — comfortably above the biggest slot it is
    /// rendered in (38 pt lock-screen row at 3×), small enough to ride along
    /// with every ContentState without weight.
    private static let side: CGFloat = 88
    private static let jpegQuality: CGFloat = 0.4
    private static let keepCount = 60

    /// videoId → base64 JPEG (what the ContentState carries).
    private var memory: [String: String] = [:]
    private var order: [String] = []

    private init() {
        try? FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true
        )
    }

    private var directory: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return caches.appendingPathComponent("thumbs", isDirectory: true)
    }

    private func fileURL(_ videoId: String) -> URL {
        let safe = videoId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? videoId
        return directory.appendingPathComponent(safe + ".jpg")
    }

    /// Cached thumb without touching the network (memory → disk) — this is
    /// what a Live Activity push reads, so it stays synchronous.
    func cached(videoId: String) -> String? {
        if let hit = memory[videoId] { return hit }
        guard let data = try? Data(contentsOf: fileURL(videoId)), !data.isEmpty else { return nil }
        let encoded = data.base64EncodedString()
        remember(videoId: videoId, encoded: encoded)
        return encoded
    }

    /// Build the thumb if it doesn't exist yet: the already-resolved square
    /// artwork (which itself prefers the downloaded copy), then the payload
    /// artwork over the network. Returns the base64 JPEG for the ContentState.
    func prepare(for track: Track) async -> String? {
        if let hit = cached(videoId: track.videoId) { return hit }
        guard let square = await Player.shared.squareArtwork(for: track) else { return nil }
        guard let thumb = Self.downscaled(square), !thumb.isEmpty else { return nil }
        try? thumb.write(to: fileURL(track.videoId), options: .atomic)
        let encoded = thumb.base64EncodedString()
        remember(videoId: track.videoId, encoded: encoded)
        DebugLog.log("thumb", "\(track.videoId) (\(thumb.count / 1024) KB)")
        return encoded
    }

    /// Square cover → 88 pt JPEG.
    private static func downscaled(_ image: UIImage) -> Data? {
        let size = CGSize(width: side, height: side)
        let renderer = UIGraphicsImageRenderer(size: size)
        let small = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return small.jpegData(compressionQuality: jpegQuality)
    }

    private func remember(videoId: String, encoded: String) {
        order.removeAll { $0 == videoId }
        order.append(videoId)
        while order.count > Self.keepCount {
            memory.removeValue(forKey: order.removeFirst())
        }
        memory[videoId] = encoded
    }
}
