//
//  LyricsView.swift
//  Carmen — the lyrics panel shown inside the Now Playing screen.
//
//  Apple-Music-style karaoke: the current line is bold white and sharp,
//  every other line sits blurred and dimmed around it, and the swap rides a
//  spring. Lines auto-scroll with the playhead and seek on tap (same as the
//  web client); `♪` instrumental rows stay quiet. Providers that only gave
//  plain text (or a synced-off preference) render as a scrollable paragraph
//  with the source credited underneath. M3 chrome: a small panel header and
//  shimmer skeletons while the lyrics load.
//

import SwiftUI

struct LyricsView: View {
    @Environment(Player.self) private var player
    @Environment(\.m3) private var m3

    var body: some View {
        VStack(spacing: 0) {
            header

            Group {
                if player.lyricsLoading {
                    loading
                } else if let lyrics = player.lyrics {
                    if lyrics.hasSyncedLines, player.syncedLyricsEnabled, let lines = lyrics.synced {
                        syncedBody(lines)
                    } else if let plain = lyrics.plainText {
                        unsyncedBody(plain, source: lyrics.source)
                    } else {
                        unavailable
                    }
                } else {
                    unavailable
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 8)
    }

    /// Small panel header — the Material chrome around the karaoke body.
    private var header: some View {
        HStack(spacing: 8) {
            Text("Lyrics")
                .font(.m3TitleMedium)
                .foregroundStyle(m3.onSurface)
            Spacer(minLength: 8)
        }
        .padding(.bottom, 6)
    }

    /// Skeleton shaped like a run of lyric lines while the fetch resolves.
    private var loading: some View {
        VStack(alignment: .leading, spacing: 18) {
            ShimmerBlock(height: 26, radius: 10)
                .frame(width: 230)
            ShimmerBlock(height: 26, radius: 10)
                .frame(width: 170)
            ShimmerBlock(height: 26, radius: 10)
                .frame(width: 280)
            ShimmerBlock(height: 20, radius: 9)
                .frame(width: 200)
            ShimmerBlock(height: 20, radius: 9)
                .frame(width: 250)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.top, 12)
    }

    private var unavailable: some View {
        M3EmptyState(
            title: "No Lyrics",
            hint: "No lyrics came back for this song.",
            systemImage: "quote.opening"
        )
    }

    // MARK: Synced

    /// Karaoke: the current line is bold, pure white and sharp; every other
    /// line sits blurred and dimmed around it, and the swap between them
    /// rides a spring. Tap any line to seek there.
    private func syncedBody(_ lines: [Lyrics.Line]) -> some View {
        // The active *vocal* line — filler (`♪`) rows never get highlighted.
        let elapsedMs = Int(player.currentTime * 1000)
        let activeIndex = player.lyrics?.vocalLineIndex(atMs: elapsedMs)

        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                        let isActive = index == activeIndex

                        Button {
                            player.seek(to: Double(line.timeMs) / 1000)
                        } label: {
                            Text(line.text.isEmpty ? "♪" : line.text)
                                .font(
                                    .system(
                                        size: isActive ? 28 : 20,
                                        weight: isActive ? .bold : .semibold
                                    )
                                )
                                .foregroundStyle(Color.white.opacity(isActive ? 1 : 0.4))
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(index)
                                // The line in the spotlight is crisp; the rest
                                // fall out of focus, softly.
                                .blur(radius: isActive ? 0 : 1.6)
                                .scaleEffect(isActive ? 1 : 0.97, anchor: .leading)
                                .shadow(
                                    color: .black.opacity(isActive ? 0.35 : 0),
                                    radius: 8,
                                    y: 2
                                )
                                .opacity(line.isFiller && !isActive ? 0.35 : 1)
                                .animation(.spring(response: 0.38, dampingFraction: 0.82), value: isActive)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 8)
            }
            .scrollDismissesKeyboard(.immediately)
            .onChange(of: activeIndex) { _, newIndex in
                guard let newIndex else { return }
                withAnimation(.spring(response: 0.4, dampingFraction: 0.85)) {
                    proxy.scrollTo(newIndex, anchor: .center)
                }
            }
            .onAppear {
                if let activeIndex {
                    proxy.scrollTo(activeIndex, anchor: .center)
                }
            }
        }
    }

    // MARK: Unsynced

    private func unsyncedBody(_ plain: String, source: String?) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(plain)
                    .font(.m3TitleLarge)
                    .foregroundStyle(m3.onSurface)
                    .lineSpacing(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 8)
                if let source, !source.isEmpty {
                    Text("Lyrics: \(source)")
                        .font(.m3BodySmall)
                        .foregroundStyle(m3.onSurfaceVariant)
                }
            }
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
