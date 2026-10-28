//
//  LibraryView.swift
//  Carmen — the Library tab as the Material 3 clone of Android's library
//  screen: a pinned top app bar and a row of filter-chip tabs over a
//  swipeable pager (Mix / Playlists / Songs / Artists / Albums /
//  Downloads). Everything here is local state (LibraryStore +
//  DownloadsStore) — nothing is fetched, so no loading/error states are
//  needed.
//

import Foundation
import SwiftUI

struct LibraryView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(DownloadsStore.self) private var downloads
    @Environment(Player.self) private var player
    @Environment(\.m3) private var m3

    /// Selected tab — the chip row and the pager read and write the same
    /// persisted value (Android remembers its chip the same way).
    @AppStorage("carmen.library.tab") private var storedTab = LibraryTab.mix.rawValue

    @State private var showSettings = false
    @State private var showSpotifyImport = false
    @State private var showingNewPlaylist = false
    @State private var newName = ""
    @State private var showingRename = false
    @State private var renameTarget: LocalPlaylist?
    @State private var renameText = ""
    @State private var showingDelete = false
    @State private var deleteTarget: LocalPlaylist?
    @State private var openedPlaylist: LocalPlaylist?
    @State private var playlistMenuTarget: LocalPlaylist?
    @State private var podcastMenuTarget: SavedPodcast?
    @State private var showRemoveAll = false
    @State private var favoritesSort: LibrarySongSort = .recent
    @State private var pushedRoute: LibraryRoutePush?

    private let gridColumns = [
        GridItem(.flexible(), spacing: 16),
        GridItem(.flexible(), spacing: 16),
    ]

    var body: some View {
        TabView(selection: tabSelection) {
            mixPage.tag(LibraryTab.mix.rawValue)
            playlistsPage.tag(LibraryTab.playlists.rawValue)
            podcastsPage.tag(LibraryTab.podcasts.rawValue)
            songsPage.tag(LibraryTab.songs.rawValue)
            artistsPage.tag(LibraryTab.artists.rawValue)
            albumsPage.tag(LibraryTab.albums.rawValue)
            downloadsPage.tag(LibraryTab.downloads.rawValue)
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .background { libraryBackdrop.ignoresSafeArea() }
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top, spacing: 0) { header }
        // GridTile's label is a Button, so it can't nest inside a
        // NavigationLink — taps route through this item-based push instead.
        // The wrapper type keeps it distinct from `carmenDestinations()`'
        // `for: Route.self` destination on the same stack.
        .navigationDestination(item: $pushedRoute) { pushedDestination($0) }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .sheet(item: $openedPlaylist) { playlist in
            LocalPlaylistSheet(playlist: playlist)
        }
        .sheet(isPresented: $showSpotifyImport) {
            SpotifyImportSheet { playlist in
                showSpotifyImport = false
                // Let the import sheet finish dismissing before the playlist
                // sheet tries to present on top of it.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    openedPlaylist = playlist
                }
            }
            .presentationDetents([.large])
            .presentationCornerRadius(28)
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
    }

    // MARK: - Backdrop

    /// Same 430pt tonal band Android's LibraryScreen paints under the header:
    /// primary container (30%) → secondary container (14% at 42%) → clear.
    private var libraryBackdrop: some View {
        VStack(spacing: 0) {
            LinearGradient(
                stops: [
                    .init(color: m3.primaryContainer.opacity(0.30), location: 0),
                    .init(color: m3.secondaryContainer.opacity(0.14), location: 0.42),
                    .init(color: .clear, location: 1.0),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: 430)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Tab plumbing

    private var selectedTab: LibraryTab {
        LibraryTab(rawValue: storedTab) ?? .mix
    }

    /// One source of truth: the chips write it, the pager reads and writes
    /// it. Unrecognized persisted values fall back to Mix.
    private var tabSelection: Binding<String> {
        Binding(
            get: { selectedTab.rawValue },
            set: { storedTab = $0 }
        )
    }

    private func select(_ tab: LibraryTab) {
        withAnimation(.snappy(duration: 0.3)) {
            storedTab = tab.rawValue
        }
    }

    /// Pinned header: the floating top bar with the overflow, then the
    /// horizontally scrolling pill-chip tabs (Android's ExpressiveTabChip).
    private var header: some View {
        VStack(spacing: 0) {
            TopAppBar(title: "Library", onOverflow: { showSettings = true })
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(LibraryTab.allCases, id: \.self) { tab in
                        FilterChip(
                            isSelected: selectedTab == tab,
                            title: tab.rawValue,
                            systemImage: tab.systemImage
                        ) {
                            select(tab)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 2)
                .padding(.bottom, 10)
            }
        }
        .background { m3.background.ignoresSafeArea() }
    }

    // MARK: - Mix

    private var mixPage: some View {
        ScrollView {
            VStack(spacing: 12) {
                mixCard(
                    title: "Favorites",
                    subtitle: library.favorites.isEmpty
                        ? "Songs you heart show up here"
                        : "\(library.favorites.count) songs",
                    systemImage: "heart.fill"
                ) {
                    select(.songs)
                }

                mixCard(
                    title: "Downloads",
                    subtitle: downloads.downloadedIds.isEmpty
                        ? "Download songs to listen offline"
                        : "\(downloads.downloadedIds.count) songs · \(downloads.totalSizeLabel)",
                    systemImage: "arrow.down.circle.fill"
                ) {
                    select(.downloads)
                }

                // No "Recents" tab — this card plays what it lists.
                mixCard(
                    title: "Recent activity",
                    subtitle: library.recents.isEmpty
                        ? "Songs you play show up here"
                        : Array(library.recents.prefix(3)).map(\.title).joined(separator: " · "),
                    systemImage: "clock.arrow.circlepath"
                ) {
                    player.play(library.recents)
                }

                mixCard(
                    title: "Playlists",
                    subtitle: library.playlists.isEmpty
                        ? "Create one in the Playlists tab"
                        : Array(library.playlists.prefix(3)).map(\.name).joined(separator: " · "),
                    systemImage: "music.note.list"
                ) {
                    select(.playlists)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
    }

    /// One Mix shortcut row: 40pt primary-container circle, title/subtitle,
    /// trailing chevron. Cards with nothing to count show a hint subtitle
    /// instead of hiding (Android keeps its shortcut grid visible too).
    private func mixCard(
        title: String,
        subtitle: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        M3Card(padding: 14, action: action) {
            HStack(spacing: 12) {
                ZStack {
                    Circle()
                        .fill(m3.primaryContainer)
                        .frame(width: 40, height: 40)
                    Image(systemName: systemImage)
                        .font(.m3BodyLarge)
                        .foregroundStyle(m3.primary)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.m3TitleSmall)
                        .foregroundStyle(m3.onSurface)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(.m3BodySmall)
                        .foregroundStyle(m3.onSurfaceVariant)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right")
                    .font(.m3BodySmall)
                    .foregroundStyle(m3.outline)
            }
        }
        .pressScale(0.99)
    }

    // MARK: - Playlists

    private var playlistsPage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(title: "Playlists", actionTitle: "+") {
                    showingNewPlaylist = true
                }

                // The frontend's "Import from Spotify" header button —
                // pasted link → YT Music matches → a local playlist.
                M3Card(padding: 14, action: { showSpotifyImport = true }) {
                    HStack(spacing: 12) {
                        ZStack {
                            Circle()
                                .fill(Color(hex: "1DB954"))
                                .frame(width: 40, height: 40)
                            Image(systemName: "play.fill")
                                .font(.system(size: 15, weight: .bold))
                                .foregroundStyle(.white)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Import from Spotify")
                                .font(.m3TitleSmall)
                                .foregroundStyle(m3.onSurface)
                                .lineLimit(1)
                            Text("Paste a playlist link — songs get matched on YouTube Music")
                                .font(.m3BodySmall)
                                .foregroundStyle(m3.onSurfaceVariant)
                                .lineLimit(1)
                                .minimumScaleFactor(0.85)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: "chevron.right")
                            .font(.m3BodySmall)
                            .foregroundStyle(m3.outline)
                    }
                }
                .pressScale(0.99)
                .padding(.horizontal, 16)

                if library.playlists.isEmpty {
                    M3EmptyState(
                        title: "No playlists yet",
                        hint: "Create one with + above",
                        systemImage: "music.note.list"
                    )
                } else {
                    LazyVGrid(columns: gridColumns, spacing: 20) {
                        ForEach(library.playlists) { playlist in
                            playlistTile(playlist)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                }
            }
            .padding(.top, 4)
            .padding(.bottom, 24)
        }
        .bottomSheetMenu(isPresented: playlistMenuBinding, title: playlistMenuTarget?.name) {
            if let playlist = playlistMenuTarget {
                playlistMenu(playlist)
            }
        }
    }

    /// Android's LibraryPodcastsScreen: shows saved on-device (no account
    /// sync here — subscribe via the search results' long-press menu), each
    /// row taps through to the show's detail screen.
    private var podcastsPage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(title: "Podcasts")

                if library.podcasts.isEmpty {
                    M3EmptyState(
                        title: "No podcasts yet",
                        hint: "Search with the Podcasts filter, then long-press a show and “Save to Library”.",
                        systemImage: "mic"
                    )
                } else {
                    VStack(spacing: 0) {
                        ForEach(library.podcasts) { podcast in
                            Button {
                                pushedRoute = LibraryRoutePush(
                                    route: .podcast(playlistId: podcast.playlistId, title: podcast.title)
                                )
                            } label: {
                                HStack(spacing: 12) {
                                    ArtworkView(url: podcast.artwork, cornerRadius: 8)
                                        .frame(width: 56, height: 56)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(podcast.title)
                                            .font(.m3BodyLarge.weight(.medium))
                                            .foregroundStyle(m3.onSurface)
                                            .lineLimit(1)
                                            .minimumScaleFactor(0.85)
                                        Text(podcast.author)
                                            .font(.m3BodyMedium)
                                            .foregroundStyle(m3.onSurfaceVariant)
                                            .lineLimit(1)
                                    }
                                    Spacer(minLength: 8)
                                    Button {
                                        podcastMenuTarget = podcast
                                    } label: {
                                        Image(systemName: "ellipsis")
                                            .font(.m3BodyLarge)
                                            .foregroundStyle(m3.onSurfaceVariant)
                                            .frame(width: 36, height: 36)
                                            .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("Options for \(podcast.title)")
                                }
                                .padding(.horizontal, 16)
                                .frame(minHeight: M3Dim.listHeight)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .pressScale(0.98)
                        }
                    }
                    .padding(.top, 4)
                }
            }
            .padding(.top, 4)
            .padding(.bottom, 24)
        }
        .bottomSheetMenu(isPresented: podcastMenuBinding, title: podcastMenuTarget?.title) {
            if let podcast = podcastMenuTarget {
                podcastMenu(podcast)
            }
        }
    }

    private var podcastMenuBinding: Binding<Bool> {
        Binding(
            get: { podcastMenuTarget != nil },
            set: { presented in
                if !presented { podcastMenuTarget = nil }
            }
        )
    }

    /// Play (the show's first episode) / Remove — Android's show menu.
    @ViewBuilder
    private func podcastMenu(_ podcast: SavedPodcast) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetMenuRow(title: "Play", systemImage: "play.fill") {
                podcastMenuTarget = nil
                Task {
                    do {
                        let detail = try await API(baseURL: SettingsStore.shared.apiBaseURL)
                            .podcast(podcast.playlistId)
                        if !detail.episodes.isEmpty {
                            player.play(detail.episodes)
                        }
                    } catch {
                        DebugLog.log("library", "podcast play failed: \(error.localizedDescription)")
                    }
                }
            }
            Divider()
            SheetMenuRow(title: "Remove from Library", systemImage: "trash", tint: m3.error) {
                podcastMenuTarget = nil
                library.togglePodcast(podcast)
            }
        }
    }

    private func playlistTile(_ playlist: LocalPlaylist) -> some View {
        ZStack(alignment: .topTrailing) {
            GridTile(
                title: playlist.name,
                subtitle: "\(playlist.tracks.count) songs",
                artwork: playlist.tracks.first?.artwork,
                artworkAlt: playlist.tracks.first?.artworkAlt,
                action: { openedPlaylist = playlist }
            )
            Button {
                playlistMenuTarget = playlist
            } label: {
                Image(systemName: "ellipsis")
                    .font(.m3BodyLarge)
                    .foregroundStyle(m3.onSurfaceVariant)
                    .frame(width: 32, height: 32)
                    .background(m3.surfaceContainerHighest.opacity(0.92), in: Circle())
                    .padding(6)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Options for \(playlist.name)")
        }
    }

    private var playlistMenuBinding: Binding<Bool> {
        Binding(
            get: { playlistMenuTarget != nil },
            set: { presented in
                if !presented { playlistMenuTarget = nil }
            }
        )
    }

    /// Play / Shuffle / Rename / Delete — Android's playlist bottom-sheet
    /// menu. The dialogs live inside the sheet content (same pattern as
    /// `PlaylistPickerMenu`) so they always land on top of it.
    @ViewBuilder
    private func playlistMenu(_ playlist: LocalPlaylist) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SheetMenuRow(title: "Play", systemImage: "play.fill") {
                playlistMenuTarget = nil
                player.play(playlist.tracks)
            }
            SheetMenuRow(title: "Shuffle", systemImage: "shuffle") {
                playlistMenuTarget = nil
                player.shuffle = true
                player.play(playlist.tracks.shuffled())
            }
            Divider()
            SheetMenuRow(title: "Rename", systemImage: "pencil") {
                renameText = playlist.name
                renameTarget = playlist
                showingRename = true
            }
            SheetMenuRow(title: "Delete", systemImage: "trash", tint: m3.error) {
                deleteTarget = playlist
                showingDelete = true
            }
        }
        .alert("Rename Playlist", isPresented: $showingRename, presenting: renameTarget) { playlist in
            TextField("Name", text: $renameText)
            Button("Rename") {
                let name = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty else { return }
                library.renamePlaylist(id: playlist.id, to: name)
                playlistMenuTarget = nil
            }
            Button("Cancel", role: .cancel) {}
        } message: { playlist in
            Text("Renaming “\(playlist.name)”.")
        }
        .confirmationDialog("Delete Playlist?", isPresented: $showingDelete, presenting: deleteTarget) { playlist in
            Button("Delete Playlist", role: .destructive) {
                if openedPlaylist?.id == playlist.id { openedPlaylist = nil }
                library.deletePlaylist(id: playlist.id)
                playlistMenuTarget = nil
            }
            Button("Cancel", role: .cancel) {}
        } message: { playlist in
            Text("“\(playlist.name)” and its songs will be removed.")
        }
    }

    // MARK: - Songs

    private var songsPage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                SectionHeader(title: "Favorites", menuItems: {
                    Button {
                        player.play(sortedFavorites)
                    } label: {
                        Label("Play all", systemImage: "play.fill")
                    }
                    Button {
                        player.shuffle = true
                        player.play(sortedFavorites.shuffled())
                    } label: {
                        Label("Shuffle", systemImage: "shuffle")
                    }
                    Divider()
                    Menu {
                        ForEach(LibrarySongSort.allCases, id: \.self) { mode in
                            Button {
                                favoritesSort = mode
                            } label: {
                                if mode == favoritesSort {
                                    Label(mode.rawValue, systemImage: "checkmark")
                                } else {
                                    Text(mode.rawValue)
                                }
                            }
                        }
                    } label: {
                        Label("Sort by", systemImage: "arrow.up.arrow.down")
                    }
                })

                if sortedFavorites.isEmpty {
                    M3EmptyState(
                        title: "No favorites yet",
                        hint: "Heart any song and it shows up here.",
                        systemImage: "heart"
                    )
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(sortedFavorites.enumerated()), id: \.offset) { pair in
                            ListRow(
                                track: pair.element,
                                isPlaying: player.current?.videoId == pair.element.videoId,
                                onTap: { player.play(sortedFavorites, startAt: pair.offset) }
                            )
                        }
                    }
                    .padding(.top, 4)
                }
            }
            .padding(.top, 4)
            .padding(.bottom, 24)
        }
    }

    /// Client-side favorites sort (Android's LibrarySongsScreen menu).
    /// "Recent" is the store's own order — most recently hearted first.
    private var sortedFavorites: [Track] {
        switch favoritesSort {
        case .recent:
            return library.favorites
        case .title:
            return library.favorites.sorted {
                $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
            }
        case .artist:
            return library.favorites.sorted {
                let lhs = $0.artistLine.localizedCaseInsensitiveCompare($1.artistLine)
                if lhs == .orderedSame {
                    return $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
                }
                return lhs == .orderedAscending
            }
        }
    }

    // MARK: - Artists

    private var artistsPage: some View {
        ScrollView {
            if uniqueArtists.isEmpty {
                M3EmptyState(
                    title: "No artists yet",
                    hint: "Artists from your favorites and recent plays show up here.",
                    systemImage: "person.crop.circle"
                )
            } else {
                LazyVGrid(columns: gridColumns, spacing: 20) {
                    ForEach(uniqueArtists) { artist in
                        GridTile(
                            title: artist.name,
                            subtitle: "",
                            artwork: artist.artwork,
                            artworkAlt: artist.artworkAlt,
                            isCircular: true,
                            action: {
                                // No channel id (the ArtistRef was a bare
                                // name) → nothing to push, so the tile does
                                // nothing instead of navigating blind.
                                guard !artist.channelId.isEmpty else { return }
                                pushedRoute = LibraryRoutePush(
                                    route: .artist(channelId: artist.channelId, title: artist.name)
                                )
                            }
                        )
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
            }
        }
        .padding(.bottom, 24)
    }

    /// Unique artists across favorites + recents: keyed by lower-cased name,
    /// first artwork wins, channel id lifted from whichever `ArtistRef`
    /// carried one. Sorted alphabetically, like Android's grid.
    private var uniqueArtists: [LibraryArtistItem] {
        var items: [String: LibraryArtistItem] = [:]
        for track in library.favorites + library.recents {
            for artist in track.artists where !artist.name.isEmpty {
                let key = artist.name.lowercased()
                if var existing = items[key] {
                    if existing.channelId.isEmpty, let id = artist.id, !id.isEmpty {
                        existing.channelId = id
                        items[key] = existing
                    }
                } else {
                    items[key] = LibraryArtistItem(
                        id: key,
                        channelId: artist.id ?? "",
                        name: artist.name,
                        artwork: track.artwork,
                        artworkAlt: track.artworkAlt
                    )
                }
            }
        }
        return items.values.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    // MARK: - Albums

    private var albumsPage: some View {
        ScrollView {
            if uniqueAlbums.isEmpty {
                M3EmptyState(
                    title: "No albums yet",
                    hint: "Albums from your favorites and recent plays show up here.",
                    systemImage: "square.stack"
                )
            } else {
                LazyVGrid(columns: gridColumns, spacing: 20) {
                    ForEach(uniqueAlbums) { album in
                        GridTile(
                            title: album.name,
                            subtitle: album.artist,
                            artwork: album.artwork,
                            artworkAlt: album.artworkAlt,
                            action: {
                                if album.browseId.isEmpty {
                                    // AlbumRef never carried an id — play the
                                    // copies this device actually knows.
                                    let tracks = (library.favorites + library.recents).filter {
                                        $0.album?.name.lowercased() == album.id
                                    }
                                    player.play(tracks)
                                } else {
                                    pushedRoute = LibraryRoutePush(
                                        route: .album(browseId: album.browseId, title: album.name)
                                    )
                                }
                            }
                        )
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
            }
        }
        .padding(.bottom, 24)
    }

    /// Unique albums across favorites + recents, same rules as the artists
    /// grid (name-keyed, browse id hoisted from any AlbumRef that had one).
    private var uniqueAlbums: [LibraryAlbumItem] {
        var items: [String: LibraryAlbumItem] = [:]
        for track in library.favorites + library.recents {
            guard let album = track.album, !album.name.isEmpty else { continue }
            let key = album.name.lowercased()
            if var existing = items[key] {
                if existing.browseId.isEmpty, let id = album.id, !id.isEmpty {
                    existing.browseId = id
                    items[key] = existing
                }
            } else {
                items[key] = LibraryAlbumItem(
                    id: key,
                    browseId: album.id ?? "",
                    name: album.name,
                    artist: track.artistLine,
                    artwork: track.artwork,
                    artworkAlt: track.artworkAlt
                )
            }
        }
        return items.values.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    // MARK: - Downloads

    private var downloadsPage: some View {
        let downloaded = downloads.downloadedTracks()
        return ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                storageCard

                if downloaded.isEmpty {
                    M3EmptyState(
                        title: "No downloads",
                        hint: "Use the download button on any song to keep its audio, artwork and lyrics on this device — it then plays fully offline.",
                        systemImage: "arrow.down.circle"
                    )
                } else {
                    SectionHeader(title: "Downloaded")
                    VStack(spacing: 0) {
                        ForEach(downloaded) { track in
                            ListRow(
                                track: track,
                                isPlaying: player.current?.videoId == track.videoId,
                                onTap: {
                                    let index = downloaded.firstIndex { $0.videoId == track.videoId } ?? 0
                                    player.play(downloaded, startAt: index)
                                }
                            )
                        }
                    }
                }
            }
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .confirmationDialog("Remove all downloads?", isPresented: $showRemoveAll) {
            Button("Remove All", role: .destructive) {
                downloads.removeAll()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Every downloaded song's audio, artwork and lyrics will be deleted from this device.")
        }
    }

    private var storageCard: some View {
        let count = downloads.downloadedIds.count
        return M3Card(padding: 14) {
            HStack(spacing: 12) {
                ZStack {
                    Circle()
                        .fill(m3.primaryContainer)
                        .frame(width: 40, height: 40)
                    Image(systemName: "arrow.down.circle.fill")
                        .font(.m3BodyLarge)
                        .foregroundStyle(m3.primary)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Storage")
                        .font(.m3TitleSmall)
                        .foregroundStyle(m3.onSurface)
                        .lineLimit(1)
                    Text(
                        count == 0
                            ? "Nothing saved yet — download any song for offline playback"
                            : "\(count) songs · \(downloads.totalSizeLabel)"
                    )
                    .font(.m3BodySmall)
                    .foregroundStyle(m3.onSurfaceVariant)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if count > 0 {
                    Button {
                        showRemoveAll = true
                    } label: {
                        Text("Remove all")
                            .font(.m3LabelLarge)
                            .foregroundStyle(m3.error)
                            .padding(.horizontal, 8)
                            .frame(minHeight: 40)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .pressScale(0.96)
                    .accessibilityLabel("Remove all downloads")
                }
            }
        }
        .padding(.horizontal, 16)
    }

    // MARK: - Route pushes

    @ViewBuilder
    private func pushedDestination(_ push: LibraryRoutePush) -> some View {
        switch push.route {
        case .album(let browseId, let title):
            AlbumView(browseId: browseId, title: title)
        case .artist(let channelId, let title):
            ArtistView(channelId: channelId, title: title)
        case .playlist(let playlistId, let title):
            PlaylistView(playlistId: playlistId, title: title)
        case .podcast(let playlistId, let title):
            PodcastView(playlistId: playlistId, title: title)
        case .searchResults(let query):
            SearchResultsView(query: query)
        }
    }
}

// MARK: - Tab vocabulary

/// The six library tabs, in the Android app's order. The raw value doubles
/// as the chip label and the persisted `carmen.library.tab` value.
private enum LibraryTab: String, CaseIterable {
    case mix = "Mix"
    case playlists = "Playlists"
    case podcasts = "Podcasts"
    case songs = "Songs"
    case artists = "Artists"
    case albums = "Albums"
    case downloads = "Downloads"

    var systemImage: String {
        switch self {
        case .mix: return "waveform"
        case .playlists: return "music.note.list"
        case .podcasts: return "mic"
        case .songs: return "music.note"
        case .artists: return "person"
        case .albums: return "square.stack"
        case .downloads: return "arrow.down.circle"
        }
    }
}

/// Client-side favorites ordering for the Songs tab's sort menu.
private enum LibrarySongSort: String, CaseIterable {
    case title = "Title"
    case recent = "Recent"
    case artist = "Artist"
}

/// One unique artist derived from favorites + recents.
private struct LibraryArtistItem: Identifiable {
    let id: String  // lower-cased name — the unique key
    var channelId: String  // "" when no ArtistRef carried one
    let name: String
    let artwork: String?
    let artworkAlt: String?
}

/// One unique album derived from favorites + recents.
private struct LibraryAlbumItem: Identifiable {
    let id: String  // lower-cased name — the unique key
    var browseId: String  // "" when no AlbumRef carried one
    let name: String
    let artist: String
    let artwork: String?
    let artworkAlt: String?
}

/// Payload for the item-based navigation push (see the note on
/// `navigationDestination` in `LibraryView.body`).
private struct LibraryRoutePush: Hashable {
    let route: Route
}

// MARK: - Local playlist sheet

/// One on-device playlist: artwork header with Play/Shuffle, an editable
/// track list (EditButton + onDelete) and every track's Material menu.
struct LocalPlaylistSheet: View {
    let playlist: LocalPlaylist

    @Environment(LibraryStore.self) private var library
    @Environment(Player.self) private var player
    @Environment(\.m3) private var m3
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
                        M3EmptyState(
                            title: "No Songs Yet",
                            hint: "Add songs from the menu on any track.",
                            systemImage: "music.note.list"
                        )
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                    }
                } else {
                    Section {
                        ForEach(Array(current.tracks.enumerated()), id: \.offset) { pair in
                            ListRow(
                                track: pair.element,
                                isPlaying: player.current?.videoId == pair.element.videoId,
                                onTap: { player.play(current.tracks, startAt: pair.offset) }
                            )
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                        }
                        .onDelete(perform: remove)
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background { m3.background.ignoresSafeArea() }
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
                .font(.m3BodyMedium)
                .foregroundStyle(m3.onSurfaceVariant)
            if !current.tracks.isEmpty {
                HStack(spacing: 12) {
                    Button {
                        player.play(current.tracks)
                    } label: {
                        Label("Play", systemImage: "play.fill")
                    }
                    .buttonStyle(M3FilledStyle())

                    Button {
                        player.shuffle = true
                        player.play(current.tracks.shuffled())
                    } label: {
                        Label("Shuffle", systemImage: "shuffle")
                    }
                    .buttonStyle(M3TonalStyle())
                }
                .padding(.horizontal, 2)
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
