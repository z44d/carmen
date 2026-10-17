//
//  LyricsView.swift
//  Carmen — the lyrics panel shown inside the Now Playing screen.
//
//  Timed lines highlight in the accent color, auto-scroll with the playhead
//  and seek on tap (same as the web client); `♪` instrumental rows stay
//  quiet. Providers that only gave plain text render as a scrollable
//  paragraph with the source credited underneath.
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

    private func syncedBody(_ lines: [Lyrics.Line]) -> some View {
        // The active *vocal* line — filler (`♪`) rows never get highlighted.
        let elapsedMs = Int(player.currentTime * 1000)
        let activeIndex = player.lyrics?.vocalLineIndex(atMs: elapsedMs)

        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                        let isActive = index == activeIndex
                        // Dim upcoming lines hard, fade the passed ones gently.
                        let opacity = lineOpacity(index: index, activeIndex: activeIndex)

                        Button {
                            player.seek(to: Double(line.timeMs) / 1000)
                        } label: {
                            Text(line.text.isEmpty ? "♪" : line.text)
                                .font(isActive ? .title2.weight(.bold) : .title3)
                                .foregroundStyle(isActive ? Color.carmen : Color.primary.opacity(opacity))
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(index)
                                .opacity(line.isFiller ? 0.35 : 1)
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
                withAnimation(.easeInOut(duration: 0.35)) {
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

    /// 1 for active and past lines, quick fade for the next few, faint after.
    private func lineOpacity(index: Int, activeIndex: Int?) -> Double {
        guard let activeIndex else { return 0.4 }  // before the first line
        if index <= activeIndex { return 0.9 }
        switch index - activeIndex {
        case 1: return 0.65
        case 2: return 0.5
        case 3: return 0.4
        default: return 0.3
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
