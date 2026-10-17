//
//  LibraryView.swift
//  Carmen — the Library tab: favorites, recently played and on-device
//  playlists. Everything here is local state (LibraryStore) — nothing is
//  fetched, so no loading/error states are needed.
//

import SwiftUI

struct LibraryView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(DownloadsStore.self) private var downloads

    @State private var showingNewPlaylist = false
    @State private var newName = ""
    @State private var showingSettings = false
    @State private var showingRename = false
    @State private var renameTarget: LocalPlaylist?
    @State private var renameText = ""
    @State private var showingDelete = false
    @State private var deleteTarget: LocalPlaylist?
    @State private var openedPlaylist: LocalPlaylist?
    @State private var tracksSheet: TracksSheetItem?

    var body: some View {
        ScrollView {
            ScrollViewReader { proxy in
                VStack(alignment: .leading, spacing: 26) {
                    HStack(spacing: 10) {
                        chip(title: "Favorite Songs", symbol: "heart.fill", count: library.favorites.count) {
                            tracksSheet = TracksSheetItem(title: "Favorite Songs", tracks: library.favorites)
                        }
                        chip(title: "Downloads", symbol: "arrow.down.circle.fill", count: downloads.downloadedIds.count) {
                            withAnimation { proxy.scrollTo("downloads", anchor: .top) }
                        }
                        chip(title: "Recently Played", symbol: "clock.arrow.circlepath", count: library.recents.count) {
                            tracksSheet = TracksSheetItem(title: "Recently Played", tracks: library.recents)
                        }
                        chip(title: "Playlists", symbol: "music.note.list", count: library.playlists.count) {
                            withAnimation { proxy.scrollTo("playlists", anchor: .top) }
                        }
                    }
                    .padding(.horizontal)

                    favoritesSection
                    downloadsSection
                        .id("downloads")
                    recentsSection
                    playlistsSection
                        .id("playlists")
                }
                .padding(.vertical, 12)
            }
        }
        .navigationTitle("Library")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingNewPlaylist = true
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("New Playlist")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingSettings = true
                } label: {
                    Image(systemName: "gearshape")
                }
                .accessibilityLabel("Settings")
            }
        }
        .sheet(item: $tracksSheet) { item in
            AllTracksSheet(title: item.title, tracks: item.tracks)
        }
        .sheet(item: $openedPlaylist) { playlist in
            LocalPlaylistSheet(playlist: playlist)
        }
        .sheet(isPresented: $showingSettings) {
            NavigationStack { SettingsView() }
        }
        .alert("New Playlist", isPresented: $showingNewPlaylist) {
            TextField("Name", text: $newName)
            Button("Create") {
                let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty else { return }
                library.createPlaylist(named: name)
                newName = ""
            }
            Button("Cancel", role: .cancel) { newName = "" }
        }
        .alert("Rename Playlist", isPresented: $showingRename, presenting: renameTarget) { playlist in
            TextField("Name", text: $renameText)
            Button("Rename") {
                let name = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty else { return }
                library.renamePlaylist(id: playlist.id, to: name)
            }
            Button("Cancel", role: .cancel) {}
        } message: { playlist in
            Text("Renaming “\(playlist.name)”.")
        }
        .confirmationDialog("Delete Playlist?", isPresented: $showingDelete, presenting: deleteTarget) { playlist in
            Button("Delete Playlist", role: .destructive) {
                if openedPlaylist?.id == playlist.id { openedPlaylist = nil }
                library.deletePlaylist(id: playlist.id)
            }
            Button("Cancel", role: .cancel) {}
        } message: { playlist in
            Text("“\(playlist.name)” and its songs will be removed.")
        }
    }

    // MARK: - Sections

    private var favoritesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Favorites", count: library.favorites.count) {
                tracksSheet = TracksSheetItem(title: "Favorite Songs", tracks: library.favorites)
            }
            if library.favorites.isEmpty {
                EmptyState(title: "No Favorites", hint: "Songs you heart show up here.")
            } else {
                trackRows(library.favorites)
            }
        }
    }

    private var downloadsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Downloads", count: downloads.downloadedIds.count) {
                tracksSheet = TracksSheetItem(title: "Downloads", tracks: downloads.downloadedTracks())
            }
            if downloads.downloadedIds.isEmpty {
                EmptyState(
                    title: "No Downloads",
                    hint: "Use the download button on any song to keep its audio, artwork and lyrics on this device — it then plays fully offline."
                )
            } else {
                trackRows(downloads.downloadedTracks())
            }
        }
    }

    private var recentsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Recently Played", count: library.recents.count) {
                tracksSheet = TracksSheetItem(title: "Recently Played", tracks: library.recents)
            }
            if library.recents.isEmpty {
                EmptyState(title: "No Recent Plays", hint: "Songs you play show up here.")
            } else {
                trackRows(library.recents)
            }
        }
    }

    private var playlistsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Playlists")
            if library.playlists.isEmpty {
                EmptyState(title: "No Playlists", hint: "Tap + to make one.")
            } else {
                VStack(spacing: 2) {
                    ForEach(library.playlists) { playlist in
                        Button {
                            openedPlaylist = playlist
                        } label: {
                            PlaylistRow(playlist: playlist)
                        }
                        .buttonStyle(.plain)
                        .padding(.horizontal)
                        .padding(.vertical, 6)
                        .contextMenu {
                            Button {
                                renameText = playlist.name
                                renameTarget = playlist
                                showingRename = true
                            } label: {
                                Label("Rename", systemImage: "pencil")
                            }
                            Divider()
                            Button(role: .destructive) {
                                deleteTarget = playlist
                                showingDelete = true
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Pieces

    @ViewBuilder
    private func chip(title: String, symbol: String, count: Int, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: symbol)
                    .font(.title3)
                    .foregroundStyle(Color.carmen)
                Text("\(count)")
                    .font(.title3.weight(.bold))
                    .monospacedDigit()
                Text(title)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .padding(.horizontal, 6)
            .glassCard(cornerRadius: 16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func sectionHeader(_ title: String, count: Int, seeAll: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            Text(title)
                .font(.title3.weight(.bold))
            Spacer()
            if count > 5 {
                Button("See All", action: seeAll)
                    .font(.subheadline.weight(.semibold))
            }
        }
        .padding(.horizontal)
    }

    /// The first five rows of a local list, played inside the full context.
    private func trackRows(_ tracks: [Track]) -> some View {
        VStack(spacing: 2) {
            ForEach(Array(tracks.prefix(5).enumerated()), id: \.offset) { pair in
                TrackRow(track: pair.element, context: tracks)
                    .padding(.horizontal)
                    .padding(.vertical, 6)
            }
        }
    }
}

/// Payload for the “See All” sheets.
private struct TracksSheetItem: Identifiable {
    let id = UUID()
    let title: String
    let tracks: [Track]
}

/// One playlist row in the Library list.
private struct PlaylistRow: View {
    let playlist: LocalPlaylist

    var body: some View {
        HStack(spacing: 12) {
            ArtworkView(
                url: playlist.tracks.first?.artwork,
                fallbackURL: playlist.tracks.first?.artworkAlt,
                cornerRadius: 6,
                placeholderSymbol: "music.note.list"
            )
            .frame(width: 44, height: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(playlist.name)
                    .font(.body)
                    .lineLimit(1)
                Text("\(playlist.tracks.count) songs")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }
}

// MARK: - Full list sheets

/// “See All” sheet for a local track list (favorites, recents).
private struct AllTracksSheet: View {
    let title: String
    let tracks: [Track]

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if tracks.isEmpty {
                    EmptyState(title: "Nothing Here Yet", hint: "Songs you add will show up here.")
                        .listRowBackground(Color.clear)
                } else {
                    ForEach(Array(tracks.enumerated()), id: \.offset) { pair in
                        TrackRow(track: pair.element, context: tracks)
                    }
                }
            }
            .listStyle(.plain)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .carmenDestinations()
    }
}

// MARK: - Local playlist sheet

/// One on-device playlist: artwork header with Play/Shuffle, an editable
/// track list (EditButton + onDelete) and TrackRow's context menus.
struct LocalPlaylistSheet: View {
    let playlist: LocalPlaylist

    @Environment(LibraryStore.self) private var library
    @Environment(Player.self) private var player
    @Environment(\.dismiss) private var dismiss

    /// Re-read the store on every render so edits show up immediately.
    private var current: LocalPlaylist {
        library.playlist(id: playlist.id) ?? playlist
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    header
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
                if current.tracks.isEmpty {
                    Section {
                        EmptyState(title: "No Songs Yet", hint: "Add songs from the menu on any track.")
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                    }
                } else {
                    Section {
                        ForEach(Array(current.tracks.enumerated()), id: \.offset) { pair in
                            TrackRow(track: pair.element, context: current.tracks)
                        }
                        .onDelete(perform: remove)
                    }
                }
            }
            .listStyle(.plain)
            .navigationTitle(current.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !current.tracks.isEmpty {
                    ToolbarItem(placement: .topBarLeading) {
                        EditButton()
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .carmenDestinations()
    }

    private var header: some View {
        VStack(spacing: 14) {
            ArtworkView(
                url: current.tracks.first?.artwork,
                fallbackURL: current.tracks.first?.artworkAlt,
                cornerRadius: 8,
                placeholderSymbol: "music.note.list"
            )
            .frame(width: 160, height: 160)
            Text("\(current.tracks.count) songs")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if !current.tracks.isEmpty {
                HStack(spacing: 12) {
                    GlassPrimaryButton {
                        player.play(current.tracks)
                    } label: {
                        Label("Play", systemImage: "play.fill")
                            .font(.body.weight(.semibold))
                    }
                    GlassPlainButton {
                        player.shuffle = true
                        player.play(current.tracks.shuffled())
                    } label: {
                        Image(systemName: "shuffle")
                            .font(.body.weight(.semibold))
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
    }

    private func remove(_ offsets: IndexSet) {
        let removed = offsets.compactMap { index in
            current.tracks.indices.contains(index) ? current.tracks[index] : nil
        }
        // toggleTrack removes by video id — dedupe so a repeated id can't
        // toggle back on after its first removal.
        var seen = Set<String>()
        for track in removed where seen.insert(track.videoId).inserted {
            library.toggleTrack(track, inPlaylist: current.id)
        }
    }
}
