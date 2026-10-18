//
//  DownloadActivityAttributes.swift
//  Carmen — SHARED between the Carmen app target and the CarmenLiveActivity
//  widget extension (listed in both targets' sources in project.yml).
//
//  ActivityKit data model for the download Live Activity: which song is
//  being saved + how many bytes have landed so far, so the Lock Screen can
//  show "how much downloaded / how much remains" while the background
//  URLSession keeps transferring with the app suspended.
//

import ActivityKit
import Foundation

struct DownloadActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable, Sendable {
        var title: String
        var artist: String
        /// Artwork URL, rendered by the widget with AsyncImage.
        var artworkURL: String?
        /// 0.0 … 1.0 of the audio bytes received.
        var progress: Double
        var receivedBytes: Int64
        /// 0 when the server never declared a length.
        var totalBytes: Int64
        var isDone: Bool
        var isFailed: Bool
    }

    /// Video id of the song being downloaded.
    var videoId: String
}
