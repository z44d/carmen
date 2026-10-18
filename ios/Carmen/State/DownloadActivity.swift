//
//  DownloadActivity.swift
//  Carmen — manages the per-song download Live Activities.
//
//  One activity per in-flight download (ActivityKit allows a handful at
//  once), pushed entirely locally: the background URLSession reports byte
//  progress through DownloadsStore and this controller mirrors it onto the
//  Lock Screen / Dynamic Island. No APNs push is used.
//

import ActivityKit
import Foundation

@MainActor
final class DownloadActivityController {
    static let shared = DownloadActivityController()

    /// videoId → live activity (usually at most one).
    private var activities: [String: Activity<DownloadActivityAttributes>] = [:]
    /// Last state per videoId — used to skip no-op updates.
    private var lastStates: [String: DownloadActivityAttributes.ContentState] = [:]

    private init() {}

    var activitiesEnabled: Bool {
        ActivityAuthorizationInfo().areActivitiesEnabled
    }

    /// Re-attach to activities that survived an app relaunch (the download
    /// keeps going in the background; the process may not have).
    func adoptExisting() {
        guard activities.isEmpty else { return }
        for existing in Activity<DownloadActivityAttributes>.activities {
            activities[existing.attributes.videoId] = existing
            lastStates[existing.attributes.videoId] = existing.content.state
        }
    }

    /// Start the progress card when a download starts.
    func start(track: Track, videoId: String) {
        guard SettingsStore.shared.downloadLiveActivitiesEnabled, activitiesEnabled else { return }
        adoptExisting()
        guard activities[videoId] == nil else { return }
        let state = DownloadActivityAttributes.ContentState(
            title: track.title,
            artist: track.artistLine,
            artworkURL: track.artwork ?? track.artworkAlt,
            progress: 0,
            receivedBytes: 0,
            totalBytes: 0,
            isDone: false,
            isFailed: false
        )
        let attributes = DownloadActivityAttributes(videoId: videoId)
        let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(60 * 60))
        lastStates[videoId] = state
        // `Activity.request` is async throws; the controller stays synchronous
        // and fire-and-forgets, like the lyric activity does.
        Task { [weak self] in
            do {
                let activity = try await Activity.request(
                    attributes: attributes,
                    content: content,
                    pushType: nil
                )
                self?.activities[videoId] = activity
            } catch {
                self?.activities[videoId] = nil
                self?.lastStates[videoId] = nil
            }
        }
    }

    /// Byte progress from the background session (throttled by the store).
    func update(videoId: String, progress: Double, received: Int64, total: Int64) {
        guard SettingsStore.shared.downloadLiveActivitiesEnabled, activitiesEnabled else { return }
        adoptExisting()
        guard let activity = activities[videoId], var state = lastStates[videoId] else { return }
        state.progress = progress
        state.receivedBytes = received
        state.totalBytes = total
        guard state != lastStates[videoId] else { return }
        Task { await activity.update(using: state) }
        lastStates[videoId] = state
    }

    /// The audio landed (or died): flip the card to its end state, let the
    /// system dismiss it on tap.
    func end(videoId: String, failed: Bool) {
        guard let activity = activities[videoId] else { return }
        var state =
            lastStates[videoId]
            ?? DownloadActivityAttributes.ContentState(
                title: "",
                artist: "",
                artworkURL: nil,
                progress: 0,
                receivedBytes: 0,
                totalBytes: 0,
                isDone: false,
                isFailed: false
            )
        state.isDone = !failed
        state.isFailed = failed
        if !failed { state.progress = 1 }
        Task { try? await activity.end(using: state, dismissalPolicy: .default) }
        activities[videoId] = nil
        lastStates[videoId] = nil
    }

    /// The user removed the download — drop the card without an end state.
    func dismiss(videoId: String) {
        guard let activity = activities[videoId] else { return }
        Task { try? await activity.end(nil, dismissalPolicy: .immediate) }
        activities[videoId] = nil
        lastStates[videoId] = nil
    }
}
