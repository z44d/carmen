//
//  QueueView.swift
//  Carmen — the "Up Next" sheet: current track, reorderable upcoming list,
//  swipe-to-remove. Tapping a row jumps the playhead to it.
//

import SwiftUI

struct QueueView: View {
    @Environment(Player.self) private var player

    /// Absolute queue index of the first "Up Next" row.
    private var upcomingStart: Int { player.currentIndex + 1 }

    var body: some View {
        NavigationStack {
            Group {
                if player.queue.isEmpty {
                    EmptyState(title: "Queue is Empty", hint: "Play a song or add one from any list.")
                } else {
                    queueList
                }
            }
            .navigationTitle("Up Next")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !player.queue.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        EditButton()
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button(role: .destructive) {
                                player.stop()
                            } label: {
                                Label("Clear Queue", systemImage: "trash")
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                        }
                    }
                }
            }
        }
    }

    private var queueList: some View {
        List {
            if let current = player.current {
                Section("Playing Now") {
                    QueueRow(track: current, isPlaying: player.isPlaying, isCurrent: true)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            player.showNowPlaying = true
                        }
                }
            }

            Section("Up Next") {
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
            }
        }
        .listStyle(.insetGrouped)
    }
}

/// One queue row: artwork, title, artist, duration — no play-on-tap (the
/// list owns tapping so it can jump instead of restart).
private struct QueueRow: View {
    let track: Track
    let isPlaying: Bool
    let isCurrent: Bool

    var body: some View {
        HStack(spacing: 12) {
            ArtworkView(url: track.artwork, fallbackURL: track.artworkAlt, cornerRadius: 4)
                .frame(width: 44, height: 44)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(track.title)
                        .font(.body)
                        .lineLimit(1)
                        .foregroundStyle(isCurrent ? Color.accentColor : .primary)
                    if track.isExplicit { ExplicitBadge() }
                }
                Text(track.artistLine)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            if isPlaying {
                Image(systemName: "waveform")
                    .font(.footnote)
                    .foregroundStyle(Color.accentColor)
            } else {
                Text(track.durationLabel ?? "")
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
    }
}
