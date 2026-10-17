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

    /// The list only describes the track it was fetched for — show the
    /// skeleton while it catches up after a skip.
    private var isStale: Bool { player.relatedVideoId != player.current?.videoId }

    var body: some View {
        if isStale || player.relatedLoading {
            LoadingState(label: "Finding more like this…")
        } else if player.related.isEmpty {
            EmptyState(
                title: "Nothing Related",
                hint: "No recommendations came back for this song."
            )
        } else {
            List {
                Section {
                    ForEach(player.related) { track in
                        TrackRow(track: track, context: player.related)
                    }
                } footer: {
                    Text("More like this — plays automatically when the queue ends.")
                        .textCase(nil)
                }
            }
            .listStyle(.plain)
        }
    }
}
