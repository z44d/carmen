//
//  HomeView.swift
//  Carmen — the Home tab, mirroring the web client's personal feed.
//
//  Entirely local, zero network: the 10 most recently played songs plus up
//  to 100 suggestions harvested from the related lists of everything the
//  user plays (shuffled on every refresh). The curated YouTube Music rows
//  the server offers are deliberately not shown — the frontend dropped them
//  for the same reason: the personal feed is all this page shows.
//

import SwiftUI

struct HomeView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(Player.self) private var player

    /// Snapshots — captured on appear and refresh (frontend `raw`
    /// semantics): what's on screen keeps its order until the user refreshes.
    @State private var recentSnapshot: [Track] = []
    @State private var suggestionSnapshot: [Track] = []
    @State private var visibleSuggestions = 12
    @State private var refreshing = false

    private let columns = [GridItem(.adaptive(minimum: 150), spacing: 16)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if refreshing {
                    ProgressView()
                        .padding(.horizontal)
                }

                if !recentSnapshot.isEmpty {
                    recentlyPlayed
                }
                if !suggestionSnapshot.isEmpty {
                    suggestedForYou
                }
                if !refreshing, recentSnapshot.isEmpty, suggestionSnapshot.isEmpty {
                    EmptyState(
                        title: "Nothing here yet",
                        hint: "Songs you play show up here: your last 10 plays, plus up to 100 suggestions gathered from their related songs."
                    )
                }
            }
            .padding(.vertical, 8)
        }
        .navigationTitle("Home")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await refresh() }
                } label: {
                    Image(systemName: "arrow.triangle.2.circlepath")
                }
                .accessibilityLabel("Refresh")
            }
        }
        .refreshable {
            await refresh()
        }
        .task {
            snapshot()
        }
    }

    // MARK: Data

    /// Frontend snapshot(): recents as-is, suggestions shuffled.
    private func snapshot() {
        recentSnapshot = Array(library.recents.prefix(10))
        suggestionSnapshot = library.suggestions.shuffled()
        visibleSuggestions = 12
    }

    private func refresh() async {
        refreshing = true
        snapshot()
        // Minimum spinner so the control feels like it actually worked.
        try? await Task.sleep(for: .milliseconds(400))
        refreshing = false
    }

    // MARK: Recently played

    private var recentlyPlayed: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Recently Played")
                        .font(.title3.weight(.bold))
                    Text("Last \(recentSnapshot.count) of 10 songs")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    player.play(recentSnapshot)
                } label: {
                    Image(systemName: "play.fill")
                        .font(.subheadline)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Play recent songs")
            }
            .padding(.horizontal)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 14) {
                    ForEach(recentSnapshot) { track in
                        TrackTile(track: track, context: recentSnapshot, width: 132)
                    }
                }
                .padding(.horizontal)
            }
        }
    }

    // MARK: Suggested for you

    private var suggestedForYou: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Suggested for you")
                        .font(.title3.weight(.bold))
                    Text("\(suggestionSnapshot.count) songs gathered from songs you play")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    player.shuffle = true
                    player.play(suggestionSnapshot.shuffled())
                } label: {
                    Image(systemName: "shuffle")
                        .font(.subheadline)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Shuffle all")

                Button {
                    library.reshuffleSuggestions()
                    snapshot()
                } label: {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.subheadline)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Re-shuffle")
            }
            .padding(.horizontal)

            LazyVGrid(columns: columns, spacing: 16) {
                ForEach(
                    Array(suggestionSnapshot.prefix(visibleSuggestions).enumerated()),
                    id: \.offset
                ) { index, track in
                    TrackTile(track: track, context: suggestionContext(for: track))
                        .onAppear {
                            // Prefetch the next page before the user hits it.
                            if index >= visibleSuggestions - 6 { visibleSuggestions += 12 }
                        }
                }
            }
            .padding(.horizontal)
        }
    }

    /// Frontend playSuggestion(): `[tapped] + (recents + shuffled suggestions
    /// minus the tapped track)`.
    private func suggestionContext(for tapped: Track) -> [Track] {
        var rest = recentSnapshot + suggestionSnapshot.shuffled()
        rest.removeAll { $0.videoId == tapped.videoId }
        return [tapped] + rest
    }
}
