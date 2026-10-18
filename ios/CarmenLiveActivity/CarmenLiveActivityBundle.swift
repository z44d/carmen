//
//  CarmenLiveActivityBundle.swift
//  Carmen — widget extension entry point.
//
//  Declares the two Live Activities the Carmen app keeps alive: the lock-
//  screen lyrics card while music plays, and the download progress card
//  while a song is being saved. Both push every ContentState locally (no
//  APNs) — see State/LiveActivity.swift and State/DownloadActivity.swift.
//

import ActivityKit
import Foundation
import SwiftUI
import WidgetKit

@main
struct CarmenLiveActivityBundle: WidgetBundle {
    var body: some Widget {
        LyricLiveActivity()
        DownloadLiveActivity()
    }
}

struct LyricLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: LyricActivityAttributes.self) { context in
            // Lock screen / banner: artwork, title/artist, current line with
            // the next line dimmed under it, progress.
            LockScreenLyricView(state: context.state)
                .activityBackgroundTint(Color.black.opacity(0.55))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                // Expanded (Long Press)
                DynamicIslandExpandedRegion(.leading) {
                    ArtworkThumb(urlString: context.state.artworkURL, data: context.state.artworkData)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    elapsedTime(context.state)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.state.title)
                            .font(.footnote.weight(.semibold))
                            .lineLimit(1)
                            .foregroundStyle(.white)
                        Text(context.state.artist)
                            .font(.caption2)
                            .lineLimit(1)
                            .foregroundStyle(.white.opacity(0.65))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        if !context.state.line.isEmpty {
                            Text(context.state.line)
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.white)
                                .lineLimit(2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        if !context.state.nextLine.isEmpty {
                            Text(context.state.nextLine)
                                .font(.caption2)
                                .foregroundStyle(.white.opacity(0.5))
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        ProgressBar(value: context.state.progress)
                            .frame(height: 3)
                    }
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                ArtworkThumb(urlString: context.state.artworkURL, data: context.state.artworkData, size: 24)
            } compactTrailing: {
                HStack(spacing: 4) {
                    Image(systemName: context.state.isPlaying ? "waveform" : "pause.fill")
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.85))
                    elapsedTime(context.state)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.white.opacity(0.65))
                }
            } minimal: {
                Image(systemName: "music.note")
                    .foregroundStyle(.white)
            }
            .keylineTint(.pink)
        }
    }
}

// MARK: - Lock screen

private struct LockScreenLyricView: View {
    let state: LyricActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                ArtworkThumb(urlString: state.artworkURL, data: state.artworkData, size: 38)
                VStack(alignment: .leading, spacing: 1) {
                    Text(state.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                        .foregroundStyle(.white)
                    Text(state.artist)
                        .font(.caption)
                        .lineLimit(1)
                        .foregroundStyle(.white.opacity(0.65))
                }
                Spacer(minLength: 8)
                Image(systemName: state.isPlaying ? "waveform" : "pause.fill")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.8))
            }

            if !state.line.isEmpty {
                Text(state.line)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.white)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !state.nextLine.isEmpty {
                Text(state.nextLine)
                    .font(.footnote)
                    .foregroundStyle(.white.opacity(0.5))
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            ProgressBar(value: state.progress)
                .frame(height: 3)
        }
        .padding(14)
    }
}

// MARK: - Shared bits

/// 96 pt cover that renders from the bytes inside the state — the Lock
/// Screen presentation can't fetch a remote image itself, so the URL is
/// only the fallback path (e.g. an activity started by an older app).
private struct ArtworkThumb: View {
    let urlString: String?
    var data: String?
    var size: CGFloat = 40

    private var embedded: UIImage? {
        guard let data, let raw = Data(base64Encoded: data) else { return nil }
        return UIImage(data: raw)
    }

    var body: some View {
        Group {
            if let embedded {
                Image(uiImage: embedded)
                    .resizable()
                    .scaledToFill()
            } else {
                AsyncImage(url: urlString.flatMap(URL.init(string:))) { phase in
                    if case .success(let image) = phase {
                        image.resizable().scaledToFill()
                    } else {
                        placeholder
                    }
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size > 30 ? 6 : 4, style: .continuous))
    }

    private var placeholder: some View {
        ZStack {
            Rectangle().fill(.white.opacity(0.12))
            Image(systemName: "music.note")
                .font(.system(size: size * 0.45))
                .foregroundStyle(.white.opacity(0.6))
        }
    }
}

/// Elapsed clock: counts on its own while playback is rolling, so the card
/// doesn't freeze between ActivityKit updates (and never freezes when the
/// app is suspended between them).
private func elapsedTime(_ state: LyricActivityAttributes.ContentState) -> some View {
    if state.isPlaying {
        // Closed range anchored at "when playback started": SwiftUI
        // re-renders the text every second on its own, counting up.
        let anchor = Date().addingTimeInterval(-state.elapsed)
        let until = anchor.addingTimeInterval(max(state.duration, state.elapsed + 60))
        return AnyView(
            Text(timerInterval: anchor...until, countsDown: false, showsHours: state.duration >= 3600)
                .font(.footnote.monospacedDigit())
                .foregroundStyle(.white.opacity(0.7))
        )
    }
    return AnyView(
        Text(clock(state.elapsed))
            .font(.footnote.monospacedDigit())
            .foregroundStyle(.white.opacity(0.7))
    )
}

/// Thin progress bar — pink fill like Apple Music.
private struct ProgressBar: View {
    let value: Double

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(.white.opacity(0.2))
                Capsule()
                    .fill(.pink)
                    .frame(width: max(0, min(value, 1)) * proxy.size.width)
            }
        }
    }
}

/// `216` → `"3:36"` (the app's `formatClock` lives in the app target only).
private func clock(_ time: TimeInterval) -> String {
    let total = max(0, Int(time.rounded(.down)))
    let h = total / 3600
    let m = (total % 3600) / 60
    let s = total % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
}

// MARK: - Download progress

struct DownloadLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DownloadActivityAttributes.self) { context in
            // Lock screen / banner: which song is landing + how many bytes.
            LockScreenDownloadView(state: context.state)
                .activityBackgroundTint(Color.black.opacity(0.55))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    ArtworkThumb(urlString: context.state.artworkURL, data: context.state.artworkData)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Image(systemName: downloadSymbol(context.state))
                        .font(.footnote)
                        .foregroundStyle(.white.opacity(0.85))
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.state.title)
                            .font(.footnote.weight(.semibold))
                            .lineLimit(1)
                            .foregroundStyle(.white)
                        Text(context.state.artist)
                            .font(.caption2)
                            .lineLimit(1)
                            .foregroundStyle(.white.opacity(0.65))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(downloadCaption(context.state))
                            .font(.caption2)
                            .foregroundStyle(.white.opacity(0.7))
                            .frame(maxWidth: .infinity, alignment: .leading)
                        ProgressBar(value: context.state.progress)
                            .frame(height: 3)
                    }
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                ArtworkThumb(urlString: context.state.artworkURL, data: context.state.artworkData, size: 24)
            } compactTrailing: {
                if context.state.isDone {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.caption2)
                        .foregroundStyle(.green)
                } else if context.state.isFailed {
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.caption2)
                        .foregroundStyle(.yellow)
                } else {
                    HStack(spacing: 3) {
                        Image(systemName: "arrow.down.circle")
                            .font(.caption2)
                            .foregroundStyle(.white.opacity(0.85))
                        Text(byteLabel(context.state.progress))
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.white.opacity(0.65))
                    }
                }
            } minimal: {
                Image(systemName: downloadSymbol(context.state))
                    .foregroundStyle(.white)
            }
            .keylineTint(.green)
        }
    }
}

/// "arrow.down" while fetching, "checkmark" when saved, "!" when failed.
private func downloadSymbol(_ state: DownloadActivityAttributes.ContentState) -> String {
    if state.isDone { return "checkmark.circle.fill" }
    if state.isFailed { return "exclamationmark.circle.fill" }
    return "arrow.down.circle.fill"
}

/// One-line status under the title: bytes landed / total, or the end state.
private func downloadCaption(_ state: DownloadActivityAttributes.ContentState) -> String {
    if state.isDone { return "Downloaded — ready to play offline" }
    if state.isFailed { return "Download failed" }
    let formatter = ByteCountFormatter()
    let received = formatter.string(fromByteCount: state.receivedBytes)
    if state.totalBytes > 0 {
        return "\(received) of \(formatter.string(fromByteCount: state.totalBytes))"
    }
    return "\(received) downloaded"
}

/// "42%" for the compact trailing slot.
private func byteLabel(_ progress: Double) -> String {
    "\(Int((max(0, min(progress, 1)) * 100).rounded()))%"
}

// MARK: - Lock screen (download)

private struct LockScreenDownloadView: View {
    let state: DownloadActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                ArtworkThumb(urlString: state.artworkURL, data: state.artworkData, size: 38)
                VStack(alignment: .leading, spacing: 1) {
                    Text(state.title.isEmpty ? "Downloading" : state.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                        .foregroundStyle(.white)
                    Text(state.artist.isEmpty ? "Carmen" : state.artist)
                        .font(.caption)
                        .lineLimit(1)
                        .foregroundStyle(.white.opacity(0.65))
                }
                Spacer(minLength: 8)
                Image(systemName: downloadSymbol(state))
                    .font(.subheadline)
                    .foregroundStyle(
                        state.isDone ? Color.green : (state.isFailed ? Color.yellow : Color.white.opacity(0.8))
                    )
            }

            Text(downloadCaption(state))
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.7))
                .frame(maxWidth: .infinity, alignment: .leading)

            ProgressBar(value: state.progress)
                .frame(height: 3)
        }
        .padding(14)
    }
}
