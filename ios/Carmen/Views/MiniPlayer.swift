//
//  MiniPlayer.swift
//  Carmen — the floating now-playing bar above the tab bar. Tap opens the
//  full screen player; the trailing button plays/pauses.
//

import SwiftUI

struct MiniPlayer: View {
    @Environment(Player.self) private var player

    var body: some View {
        @Bindable var player = player

        if let track = player.current {
            HStack(spacing: 12) {
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
                        .padding(.trailing, 4)
                }

                Button {
                    player.togglePlayPause()
                } label: {
                    Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                        .font(.title3)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.primary)

                Button {
                    player.next()
                } label: {
                    Image(systemName: "forward.fill")
                        .font(.title3)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.primary)
                .disabled(!player.hasNext)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .glassCard(cornerRadius: 14)
            .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
            .contentShape(Rectangle())
            .onTapGesture {
                player.showNowPlaying = true
            }
            .contextMenu {
                Button {
                    player.togglePlayPause()
                } label: {
                    Label(
                        player.isPlaying ? "Pause" : "Play",
                        systemImage: player.isPlaying ? "pause.fill" : "play.fill")
                }
                Button {
                    player.next()
                } label: {
                    Label("Next", systemImage: "forward.fill")
                }
                Divider()
                Button {
                    player.showNowPlaying = true
                } label: {
                    Label("Show Now Playing", systemImage: "music.note.list")
                }
                Button(role: .destructive) {
                    player.stop()
                } label: {
                    Label("Clear Queue", systemImage: "xmark")
                }
            }
        }
    }
}
