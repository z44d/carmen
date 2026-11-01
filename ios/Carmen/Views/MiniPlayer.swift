//
//  MiniPlayer.swift
//  Carmen — the Material now-playing bar stacked on the nav pill.
//
//  Android's MiniPlayer: a 70pt surface bar with the cover thumb, the
//  title/artist pair and the full transport (previous / filled play circle /
//  next). A hairline progress rail rides the top edge. Tapping or swiping up
//  expands the full player. The bar is a plain rectangle — RootView stacks it
//  on the nav pill and clips the combined blob, so no corners live here.
//

import SwiftUI

struct MiniPlayer: View {
    @Environment(Player.self) private var player
    @Environment(\.m3) private var m3

    var body: some View {
        if let track = player.current {
            HStack(spacing: 12) {
                ArtworkView(url: track.artwork, fallbackURL: track.artworkAlt, cornerRadius: 10)
                    .frame(width: 46, height: 46)

                VStack(alignment: .leading, spacing: 2) {
                    Text(track.title)
                        .font(.m3TitleSmall)
                        .foregroundStyle(m3.onSurface)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    Text(track.artistLine)
                        .font(.m3BodySmall)
                        .foregroundStyle(m3.onSurfaceVariant)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }

                Spacer(minLength: 4)

                if player.isBuffering {
                    ProgressView()
                        .controlSize(.small)
                        .tint(m3.primary)
                }

                Button {
                    player.previous()
                } label: {
                    Image(systemName: "backward.fill")
                        .font(.footnote.weight(.semibold))
                        .frame(width: 28, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(M3IconButtonStyle())
                .opacity(player.hasPrevious ? 1 : 0.35)
                .accessibilityLabel("Previous")

                Button {
                    player.togglePlayPause()
                } label: {
                    Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(m3.onPrimary)
                        .frame(width: 40, height: 40)
                        .background(m3.primary, in: Circle())
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(player.isPlaying ? "Pause" : "Play")

                Button {
                    player.next()
                } label: {
                    Image(systemName: "forward.fill")
                        .font(.footnote.weight(.semibold))
                        .frame(width: 28, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(M3IconButtonStyle())
                .opacity(player.hasNext ? 1 : 0.35)
                .accessibilityLabel("Next")
            }
            .padding(.horizontal, 12)
            .frame(height: M3Dim.miniPlayer)
            .background(m3.surfaceContainer)
            .overlay(alignment: .top) {
                // Hairline progress rail, inset so it never pokes out.
                GeometryReader { proxy in
                    Capsule()
                        .fill(m3.primary)
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
