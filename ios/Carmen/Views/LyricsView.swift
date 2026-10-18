//
//  LyricsView.swift
//  Carmen — the lyrics panel shown inside the Now Playing screen.
//
//  Apple-Music-style karaoke: the current line is bold rounded white and
//  sharp, every other line sits blurred and dimmed around it, and the swap
//  rides a spring. Lines auto-scroll with the playhead and seek on tap
//  (same as the web client); `♪` instrumental rows stay quiet. Providers
//  that only gave plain text render as a scrollable paragraph with the
//  source credited underneath.
//

import SwiftUI

struct LyricsView: View {
    @Environment(Player.self) private var player

    var body: some View {
        Group {
            if player.lyricsLoading {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let lyrics = player.lyrics {
                if lyrics.hasSyncedLines, let lines = lyrics.synced {
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
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
    }

    private var unavailable: some View {
        VStack(spacing: 8) {
            Image(systemName: "quote.opening")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text("No lyrics available")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: Synced

    /// Apple-Music-style karaoke: the current line is bold, rounded, pure
    /// white and sharp; every other line sits blurred and dimmed around it,
    /// and the swap between them rides a spring. Tap any line to seek there.
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
                                        weight: isActive ? .bold : .semibold,
                                        design: .rounded
                                    )
                                )
                                .foregroundStyle(isActive ? Color.white : Color.white.opacity(0.4))
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
                    .font(.title3)
                    .lineSpacing(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let source, !source.isEmpty {
                    Text("Lyrics: \(source)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 8)
        }
    }
}
