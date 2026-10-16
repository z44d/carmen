import ActivityKit
import Foundation
import UIKit

/// Manages the single lyric Live Activity.
///
/// The app keeps the activity alive locally: the audio background mode keeps the
/// process running while playing, and we push a new `ContentState` on every line
/// change (and periodically for the progress bar). No APNs push is used.
@MainActor
final class LyricActivityController {
    static let shared = LyricActivityController()

    private var activity: Activity<LyricActivityAttributes>?
    /// Last state we sent — used to skip no-op updates.
    private var lastState: LyricActivityAttributes.ContentState?

    private init() {}

    var activitiesEnabled: Bool {
        ActivityAuthorizationInfo().areActivitiesEnabled
    }

    /// Re-attach to an activity that survived an app relaunch (e.g. the app was
    /// killed while the Live Activity was still on the Lock Screen).
    func adoptExisting() {
        guard activity == nil else { return }
        if let existing = Activity<LyricActivityAttributes>.activities.first {
            activity = existing
            lastState = existing.content.state
        }
    }

    func startIfNeeded(_ state: LyricActivityAttributes.ContentState, videoId: String) {
        guard activitiesEnabled else { return }
        adoptExisting()
        if let activity {
            if state != lastState {
                // `update(using:)` is async in the ActivityKit SDK; the
                // controller stays synchronous and fire-and-forgets.
                Task { await activity.update(using: state) }
                lastState = state
            }
            return
        }
        // `Activity.request` is async throws; the controller stays synchronous and
        // the call sites keep their shape (the player is already @MainActor).
        let attributes = LyricActivityAttributes(videoId: videoId)
        let content = ActivityContent(state: state, staleDate: staleDate(for: state))
        lastState = state
        Task {
            do {
                activity = try await Activity.request(attributes: attributes, content: content, pushType: nil)
            } catch {
                // Denied (or no island support) — the authorization flag will
                // keep later attempts from spinning.
                activity = nil
                lastState = nil
            }
        }
    }

    func update(_ state: LyricActivityAttributes.ContentState, videoId: String) {
        guard activitiesEnabled else { return }
        adoptExisting()
        guard let activity else {
            startIfNeeded(state, videoId: videoId)
            return
        }
        guard state != lastState else { return }
        Task { await activity.update(using: state) }
        lastState = state
    }

    func end() {
        guard let activity else { return }
        let final = lastState.map { state -> LyricActivityAttributes.ContentState in
            var s = state
            s.isPlaying = false
            return s
        }
        if let final {
            Task { try? await activity.end(using: final, dismissalPolicy: .immediate) }
        } else {
            // No state was ever pushed — the async API is the only bare end.
            Task { try? await activity.end(nil, dismissalPolicy: .immediate) }
        }
        self.activity = nil
        lastState = nil
    }

    /// Activity is marked stale shortly after the current line should have passed.
    /// (`elapsed` is seconds; `progress` is the 0–1 fraction — don't mix them.)
    private func staleDate(for state: LyricActivityAttributes.ContentState) -> Date {
        let remaining = max(0, state.duration - state.elapsed)
        return Date().addingTimeInterval(min(max(remaining + 5, 10), 60 * 30))
    }
}
