//
//  MiniPlayer.swift
//  Carmen — the floating now-playing bar above the tab bar.
//
//  Tapping (or dragging up) expands the full player; the trailing controls
//  are the full transport — previous, play/pause, next and a queue button
//  that opens the player straight into the Queue panel. A hairline progress
//  rail rides the top edge and the play button carries the chosen accent —
//  same chrome the frontend's PlayerBar shows.
//

import SwiftUI

struct MiniPlayer: View {
    @Environment(Player.self) private var player

    var body: some View {
        if let track = player.current {
            HStack(spacing: 10) {
                ArtworkView(url: track.artwork, fallbackURL: track.artworkAlt, cornerRadius: 6)
                    .frame(width: 40, height: 40)
                    .shadow(color: .black.opacity(0.2), radius: 3, y: 1)

                VStack(alignment: .leading, spacing: 1) {
                    Text(track.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                        .foregroundStyle(.primary)
                    Text(track.artistLine)
                        .font(.caption)
                        .lineLimit(1)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 8)

                if player.isBuffering {
                    ProgressView()
                        .controlSize(.small)
                        .padding(.trailing, 2)
                }

                Button {
                    player.previous()
                } label: {
                    Image(systemName: "backward.fill")
                        .font(.footnote)
                        .foregroundStyle(.primary)
                        .frame(width: 28, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .opacity(player.hasPrevious ? 1 : 0.35)
                .accessibilityLabel("Previous")

                Button {
                    player.togglePlayPause()
                } label: {
                    Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                        .font(.title3)
                        .foregroundStyle(Color.carmenOnAccent)
                        .frame(width: 32, height: 32)
                        .background(Circle().fill(Color.carmen))
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(player.isPlaying ? "Pause" : "Play")

                Button {
                    player.next()
                } label: {
                    Image(systemName: "forward.fill")
                        .font(.footnote)
                        .foregroundStyle(.primary)
                        .frame(width: 28, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .opacity(player.hasNext ? 1 : 0.35)
                .accessibilityLabel("Next")

                Button {
                    player.openPlayer(panel: .queue)
                } label: {
                    Image(systemName: "list.bullet")
                        .font(.footnote)
                        .foregroundStyle(.primary)
                        .frame(width: 28, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Queue")
            }
            .padding(.horizontal, 12)
            .frame(height: 56)
            .glassCard(cornerRadius: 16)
            .overlay(alignment: .top) {
                // Progress rail, inset so it never pokes out of the corners.
                GeometryReader { proxy in
                    Capsule()
                        .fill(Color.carmen)
                        .frame(width: proxy.size.width * player.progress, height: 2)
                }
                .frame(height: 2)
                .padding(.horizontal, 14)
            }
            .contentShape(Rectangle())
            .onTapGesture { player.openPlayer() }
            .gesture(
                DragGesture(minimumDistance: 8)
                    .onEnded { value in
                        if value.translation.height < -12 { player.openPlayer() }
                    }
            )
        }
    }
}
