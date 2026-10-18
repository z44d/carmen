//
//  LyricActivityAttributes.swift
//  Carmen — SHARED between the Carmen app target and the CarmenLiveActivity
//  widget extension (listed in both targets' sources in project.yml).
//
//  ActivityKit data model for the lyric Live Activity: what never changes
//  (which song is on) + the ContentState the app pushes as playback and
//  lyrics advance.
//

import ActivityKit
import Foundation

struct LyricActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable, Sendable {
        /// Current line of the lyrics (empty when instrumental / no lyrics).
        var line: String
        /// The line after the current one — shown dimmed under it.
        var nextLine: String
        var title: String
        var artist: String
        /// Artwork URL, rendered by the widget with AsyncImage.
        var artworkURL: String?
        /// The cover itself, downscaled and base64-encoded by the app — the
        /// Lock Screen can't fetch a remote image reliably on its own.
        var artworkData: String? = nil
        var isPlaying: Bool
        /// 0.0 … 1.0 through the track.
        var progress: Double
        /// Seconds since the start of the track.
        var elapsed: TimeInterval
        /// Track duration in seconds.
        var duration: TimeInterval
    }

    /// Video id of the track the activity was started for.
    var videoId: String
}
