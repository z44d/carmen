//
//  RelatedPanel.swift
//  Carmen — the "Related" tab of the Now Playing screen.
//
//  One fetch (`/browsing/related/{id}`, owned by the Player) feeds three
//  surfaces: this "More like this" list, the queue's auto-continue pool and
//  the first 10 of every play that land in Home's "Suggested for you" grid.
//

import SwiftUI

struct RelatedPanel: View {
    @Environment(Player.self) private var player
    @Environment(\.m3) private var m3

    /// The list only describes the track it was fetched for — show the
    /// skeleton while it catches up after a skip.
    private var isStale: Bool { player.relatedVideoId != player.current?.videoId }

    var body: some View {
        VStack(spacing: 0) {
            header

            if isStale || player.relatedLoading {
                ScrollView {
                    ShimmerList(rows: 6)
                        .padding(.top, 4)
                }
            } else if player.related.isEmpty {
                M3EmptyState(
                    title: "Nothing Related",
                    hint: "No recommendations came back for this song.",
                    systemImage: "sparkles"
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(player.related) { track in
                            ListRow(
                                track: track,
                                isPlaying: track.videoId == player.current?.videoId,
                                onTap: { player.play(player.related, startingAt: track) }
                            )
                        }

                        Text("More like this — plays automatically when the queue ends.")
                            .font(.m3BodySmall)
                            .foregroundStyle(m3.onSurfaceVariant)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 24)
                            .padding(.vertical, 16)
                    }
                    .padding(.bottom, 8)
                }
            }
        }
    }

    /// Small panel header — the Material chrome around the list.
    private var header: some View {
        HStack(spacing: 8) {
            Text("Related")
                .font(.m3TitleMedium)
                .foregroundStyle(m3.onSurface)
            Spacer(minLength: 8)
        }
        .padding(.horizontal, 4)
        .padding(.bottom, 4)
    }
}
