//
//  QueuePanel.swift
//  Carmen — the player's Queue panel (Android's Queue bottom sheet, and the
//  body the Queue tab can reuse).
//
//  Header with the Shuffle toggle and "Clear upcoming", a Playing Now card
//  with the animated bars, then the upcoming rows: tap to jump the playhead,
//  trailing ✕ to remove, long-press drag to reorder (drag a row onto another
//  and `Player.moveInQueue` rewrites the queue while keeping the playhead on
//  the current track).
//

import SwiftUI

struct QueuePanel: View {
    @Environment(Player.self) private var player
    @Environment(\.m3) private var m3

    /// Absolute queue index of the first "up next" row.
    private var upcomingStart: Int { player.currentIndex + 1 }
    private var upcoming: ArraySlice<Track> {
        player.queue.indices.contains(upcomingStart)
            ? player.queue[upcomingStart...] : player.queue[0..<0]
    }
    /// Exclusive end of the upcoming range (safe whenever a track is
    /// playing: currentIndex < count, so upcomingStart <= count).
    private var queueCount: Int { player.queue.count }

    var body: some View {
        VStack(spacing: 0) {
            header

            if player.current == nil {
                M3EmptyState(
                    title: "Queue is Empty",
                    hint: "Play a song to start building your queue.",
                    systemImage: "list.bullet"
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if let current = player.current {
                            playingNow(current)
                                .padding(.bottom, 10)
                        }

                        if upcoming.isEmpty {
                            M3EmptyState(title: "Nothing up next", systemImage: "tray")
                                .padding(.top, 20)
                        } else {
                            upcomingList
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                }
            }
        }
    }

    /// Panel header: title + Shuffle toggle + Clear upcoming (Android's
    /// queue header actions).
    private var header: some View {
        HStack(spacing: 8) {
            Text("Queue")
                .font(.m3TitleMedium)
                .foregroundStyle(m3.onSurface)
            Spacer(minLength: 8)
            FilterChip(isSelected: player.shuffle, title: "Shuffle", systemImage: "shuffle") {
                player.shuffle.toggle()
            }
            Button("Clear upcoming") {
                player.clearUpcoming()
            }
            .buttonStyle(M3TextStyle(compact: true))
            .disabled(upcoming.isEmpty)
            .opacity(upcoming.isEmpty ? 0.4 : 1)
        }
        .padding(.horizontal, 4)
        .padding(.bottom, 8)
    }

    /// The song that owns the queue — card wash + animated bars.
    private func playingNow(_ track: Track) -> some View {
        M3Card(padding: 12) {
            HStack(spacing: 12) {
                ArtworkView(url: track.artwork, fallbackURL: track.artworkAlt, cornerRadius: 10)
                    .frame(width: 44, height: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text(track.title)
                        .font(.m3BodyLarge.weight(.medium))
                        .foregroundStyle(m3.primary)
                        .lineLimit(1)
                    Text(track.artistLine)
                        .font(.m3BodySmall)
                        .foregroundStyle(m3.onSurfaceVariant)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                PlayingIndicator()
            }
            .contentShape(Rectangle())
        }
    }

    private var upcomingList: some View {
        VStack(spacing: 0) {
            ForEach(upcomingStart..<queueCount, id: \.self) { index in
                queueRow(index)
            }
        }
    }

    /// One upcoming row at an absolute queue index: tap jumps the playhead,
    /// trailing ✕ removes, drag a row onto another to reorder.
    @ViewBuilder
    private func queueRow(_ index: Int) -> some View {
        QueuePanelRow(track: player.queue[index])
            .contentShape(Rectangle())
            .onTapGesture { player.jump(to: index) }
            // Int doesn't conform to Transferable — the row carries its queue
            // index as a one-field string payload instead.
            .draggable(String(index))
            .dropDestination(for: String.self) { payloads, _ in
                guard let text = payloads.first, let from = Int(text), from != index,
                    player.queue.indices.contains(from)
                else { return false }
                player.moveInQueue(from: IndexSet(integer: from), to: index)
                return true
            }
    }
}

/// One compact upcoming row: 44pt thumb, title/artist, trailing ✕ that
/// removes the entry without hunting for a swipe gesture.
private struct QueuePanelRow: View {
    let track: Track

    @Environment(Player.self) private var player
    @Environment(\.m3) private var m3

    var body: some View {
        HStack(spacing: 12) {
            ArtworkView(url: track.artwork, fallbackURL: track.artworkAlt, cornerRadius: 10)
                .frame(width: 44, height: 44)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(track.title)
                        .font(.m3BodyMedium)
                        .foregroundStyle(m3.onSurface)
                        .lineLimit(1)
                    if track.isExplicit { ExplicitBadge() }
                }
                Text(track.artistLine)
                    .font(.m3BodySmall)
                    .foregroundStyle(m3.onSurfaceVariant)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                player.removeFromQueue(at: IndexSet(integer: absoluteIndex))
            } label: {
                Image(systemName: "xmark")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(m3.onSurfaceVariant)
                    .frame(width: 28, height: 28)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove from queue")
        }
        .padding(.vertical, 6)
    }

    /// The row's place in the full queue (the panel only renders upcoming
    /// entries, so the offset has to be recovered from the queue itself).
    private var absoluteIndex: Int {
        player.queue.firstIndex { $0.videoId == track.videoId } ?? 0
    }
}
