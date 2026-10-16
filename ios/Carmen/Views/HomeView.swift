//
//  HomeView.swift
//  Carmen — the Home tab: recently played tracks from the on-device library,
//  then the server's home feed rows as horizontal card shelves.
//

import SwiftUI

struct HomeView: View {
    @Environment(SettingsStore.self) private var settings
    @Environment(LibraryStore.self) private var library
    @Environment(Player.self) private var player

    @State private var sections: [HomeSection]?
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                if !library.recents.isEmpty {
                    recentlyPlayed
                }
                if let sections {
                    ForEach(sections) { section in
                        if !section.contents.isEmpty {
                            feedRow(section)
                        }
                    }
                } else if let errorMessage {
                    ErrorState(message: errorMessage) {
                        Task { await load() }
                    }
                } else {
                    LoadingState()
                }
            }
            .padding(.vertical, 8)
        }
        .navigationTitle("Home")
        .navigationBarTitleDisplayMode(.large)
        .refreshable {
            await load()
        }
        .task {
            await load()
        }
    }

    // MARK: Recently played

    private var recentlyPlayed: some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: "Recently Played")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 14) {
                    ForEach(library.recents) { track in
                        RecentTile(track: track, context: library.recents)
                    }
                }
                .padding(.horizontal)
            }
        }
    }

    // MARK: Feed rows

    private func feedRow(_ section: HomeSection) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            SectionHeader(title: section.title)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 14) {
                    ForEach(section.contents) { card in
                        CardTile(card: card, siblings: section.contents, width: 150)
                    }
                }
                .padding(.horizontal)
            }
        }
    }

    // MARK: Loading

    private func load() async {
        errorMessage = nil
        do {
            sections = try await API(baseURL: settings.apiBaseURL).home(limit: 3)
        } catch is CancellationError {
            // Superseded — the view disappeared or a newer task started.
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// One tile of the "Recently Played" row — artwork, title, artist; tapping
/// plays the track with the rest of the recents queued behind it.
private struct RecentTile: View {
    let track: Track
    var context: [Track] = []

    @Environment(Player.self) private var player

    var body: some View {
        Button {
            player.play(track, queue: context)
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                ArtworkView(url: track.artwork, fallbackURL: track.artworkAlt, cornerRadius: 8)
                    .frame(width: 140, height: 140)
                HStack(spacing: 4) {
                    Text(track.title)
                        .font(.footnote.weight(.semibold))
                        .lineLimit(1)
                    if track.isExplicit {
                        ExplicitBadge()
                    }
                }
                Text(track.artistLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(width: 140, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
