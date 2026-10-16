//
//  CarmenLiveActivityBundle.swift
//  Carmen — widget extension entry point.
//
//  Declares the single Live Activity the Carmen app keeps alive while music
//  plays: lock-screen lyrics card + Dynamic Island. The app pushes every
//  ContentState locally (no APNs) — see State/LiveActivity.swift.
//

import ActivityKit
import Foundation
import SwiftUI
import WidgetKit

@main
struct CarmenLiveActivityBundle: WidgetBundle {
    var body: some Widget {
        LyricLiveActivity()
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
                    ArtworkThumb(urlString: context.state.artworkURL)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(clock(context.state.elapsed))
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(.white.opacity(0.7))
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
                ArtworkThumb(urlString: context.state.artworkURL, size: 24)
            } compactTrailing: {
                HStack(spacing: 4) {
                    Image(systemName: context.state.isPlaying ? "waveform" : "pause.fill")
                        .font(.caption2)
                        .foregroundStyle(.white.opacity(0.85))
                    Text(clock(context.state.elapsed))
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
                ArtworkThumb(urlString: state.artworkURL, size: 38)
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

private struct ArtworkThumb: View {
    let urlString: String?
    var size: CGFloat = 40

    var body: some View {
        AsyncImage(url: urlString.flatMap(URL.init(string:))) { phase in
            if case .success(let image) = phase {
                image.resizable().scaledToFill()
            } else {
                ZStack {
                    Rectangle().fill(.white.opacity(0.12))
                    Image(systemName: "music.note")
                        .font(.system(size: size * 0.45))
                        .foregroundStyle(.white.opacity(0.6))
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size > 30 ? 6 : 4, style: .continuous))
    }
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
