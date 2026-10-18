//
//  QueueView.swift
//  Carmen — the "Up Next" list: the Queue tab's screen and the Now Playing
//  panel it is reused from.
//
//  Count header with shuffle/clear (mirrors the web client's NPQueue), the
//  playing row on top, then upcoming rows with an explicit ✕ remove plus
//  swipe/delete and drag reordering. Tapping a row jumps the playhead to it.
//

import SwiftUI

/// The Queue as a tab (frontend parity: the drawer lists Queue right after
/// Search) — the same rows as the player's panel, under a large title.
struct QueueTabView: View {
    var body: some View {
        QueuePanel()
            .navigationTitle("Queue")
            .navigationBarTitleDisplayMode(.large)
    }
}

struct QueuePanel: View {
    @Environment(Player.self) private var player

    /// Absolute queue index of the first "Up Next" row.
    private var upcomingStart: Int { player.currentIndex + 1 }
    private var upcomingCount: Int { max(player.queue.count - upcomingStart, 0) }

    var body: some View {
        if player.queue.isEmpty {
            EmptyState(title: "Queue is Empty", hint: "Play a song to start building your queue.")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            queueList
        }
    }

    private var queueList: some View {
        List {
            if let current = player.current {
                Section("Playing Now") {
                    QueueRow(track: current, isPlaying: player.isPlaying, isCurrent: true)
                }
            }

            Section {
                ForEach(Array(player.queue.enumerated()), id: \.offset) { index, track in
                    if index >= upcomingStart {
                        QueueRow(track: track, isPlaying: false, isCurrent: false)
                            .contentShape(Rectangle())
                            .onTapGesture { player.jump(to: index) }
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button(role: .destructive) {
                                    player.removeFromQueue(at: IndexSet(integer: index))
                                } label: {
                                    Label("Remove", systemImage: "trash")
                                }
                            }
                    }
                }
                .onDelete { offsets in
                    player.removeFromQueue(at: IndexSet(offsets.map { $0 + upcomingStart }))
                }
                .onMove { offsets, destination in
                    player.moveInQueue(
                        from: IndexSet(offsets.map { $0 + upcomingStart }),
                        to: destination + upcomingStart
                    )
                }
            } header: {
                HStack(spacing: 14) {
                    Text("\(upcomingCount) tracks up next")
                        .textCase(nil)
                    Spacer()
                    Button {
                        player.shuffle.toggle()
                    } label: {
                        Image(systemName: "shuffle")
                            .foregroundStyle(player.shuffle ? Color.carmen : Color.secondary)
                    }
                    .buttonStyle(.plain)
                    Button("Clear") {
                        player.clearUpcoming()
                    }
                    .font(.footnote.weight(.semibold))
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .textCase(nil)
            } footer: {
                if upcomingCount == 0 {
                    Text("When the queue runs out, related songs take over.")
                        .textCase(nil)
                }
            }
        }
        .listStyle(.plain)
    }
}

/// One queue row: artwork, title, artist, duration — and an ✕ that removes
/// it without hunting for a swipe gesture. No play-on-tap conflict: the list
/// owns tapping so it can jump instead of restart.
private struct QueueRow: View {
    let track: Track
    let isPlaying: Bool
    let isCurrent: Bool

    @Environment(Player.self) private var player
    @Environment(LibraryStore.self) private var library
    @Environment(DownloadsStore.self) private var downloads

    var body: some View {
        HStack(spacing: 12) {
            ArtworkView(url: track.artwork, fallbackURL: track.artworkAlt, cornerRadius: 4)
                .frame(width: 44, height: 44)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(track.title)
                        .font(.body)
                        .lineLimit(1)
                        .foregroundStyle(isCurrent ? Color.carmen : .primary)
                    if track.isExplicit { ExplicitBadge() }
                }
                HStack(spacing: 4) {
                    Text(track.artistLine)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    if downloads.isDownloaded(track.videoId) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    if library.isFavorite(track.videoId) {
                        Image(systemName: "heart.fill")
                            .font(.caption2)
                            .foregroundStyle(Color.carmen)
                    }
                }
            }

            Spacer(minLength: 4)

            if isPlaying {
                Image(systemName: "waveform")
                    .font(.footnote)
                    .foregroundStyle(Color.carmen)
            } else {
                Text(track.durationLabel ?? "")
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            if !isCurrent {
                Button {
                    player.removeFromQueue(at: IndexSet(integer: player.queue.firstIndex {
                        $0.videoId == track.videoId
                    } ?? 0))
                } label: {
                    Image(systemName: "xmark")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 28, height: 28)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove from queue")
            }
        }
    }
}
