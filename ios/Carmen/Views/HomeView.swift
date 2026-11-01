//
//  HomeView.swift
//  Carmen — the Home tab, Android HomeScreen parity.
//
//  The same two local sections Android's Carmen home leads with: the 10
//  most recently played songs ("Keep listening" wide resume cards) and up
//  to 100 suggestions harvested from the related lists of everything the
//  user plays ("Suggested for you" hero carousel). The curated YouTube
//  Music rows the Carmen server offers via /browsing/home follow as media
//  shelves; if the server is unreachable they are simply omitted.
//

import SwiftUI

struct HomeView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(Player.self) private var player
    @Environment(SettingsStore.self) private var settings
    @Environment(\.m3) private var m3

    /// Snapshots — captured on appear and refresh (frontend `raw`
    /// semantics): what's on screen keeps its order until the user refreshes.
    @State private var recentSnapshot: [Track] = []
    @State private var suggestionSnapshot: [Track] = []
    @State private var visibleSuggestions = 12

    /// Curated rows from `/browsing/home` — loaded on appear, reloaded by
    /// pull-to-refresh. Never fatal: local sections stay visible on failure.
    @State private var remoteSections: [HomeSection] = []
    @State private var remoteLoading = true

    @State private var showSettings = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                suggestedForYou
                speedDial
                keepListening
                forgottenFavorites
                remote
                if !remoteLoading,
                    recentSnapshot.isEmpty,
                    suggestionSnapshot.isEmpty,
                    remoteSections.isEmpty {
                    M3EmptyState(
                        title: "Nothing here yet",
                        hint: "Songs you play show up here: your last 10 plays, plus up to 100 suggestions gathered from their related songs.",
                        systemImage: "music.note"
                    )
                }
            }
            .padding(.vertical, 8)
        }
        .background(backdrop)
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top) {
            TopAppBar(title: "Carmen", onOverflow: { showSettings = true })
        }
        .refreshable {
            await refresh()
        }
        .overlay(alignment: .bottomTrailing) {
            // Floating mini player + nav pill live at the bottom — pad the
            // FAB above them when a queue is up.
            M3Fab(systemImage: "shuffle", title: "Shuffle") {
                shuffleAll()
            }
            .padding(.trailing, 16)
            .padding(.bottom, player.hasQueue ? 96 : 24)
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .task {
            snapshot()
            await loadRemote()
        }
    }

    // MARK: Backdrop

    /// Android's tonal wash behind the feed: a 430pt band from the top,
    /// primary container (30%) → secondary container (14% at 42%) → clear.
    private var backdrop: some View {
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
        .ignoresSafeArea()
    }

    // MARK: Keep listening

    /// The 10 most recent plays as Android's wide resume cards
    /// (surfaceContainerHigh, outline border, 96pt thumb, filled play).
    @ViewBuilder private var keepListening: some View {
        if !recentSnapshot.isEmpty {
            SectionHeader(title: "Keep listening")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(Array(recentSnapshot.enumerated()), id: \.element.id) { index, track in
                        ResumeCard(track: track, activeIndex: index)
                    }
                }
                .padding(.horizontal, 16)
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
        }
    }

    /// One resume card: song info plus a 48pt filled play/pause button.
    private func ResumeCard(track: Track, activeIndex: Int) -> some View {
        let active = player.current?.videoId == track.videoId
        return Button {
            if active {
                player.togglePlayPause()
            } else {
                player.play(recentSnapshot, startAt: activeIndex)
            }
        } label: {
            HStack(spacing: 12) {
                ZStack {
                    ArtworkView(url: track.artwork, fallbackURL: track.artworkAlt, cornerRadius: 16)
                        .frame(width: 96, height: 96)
                    if active {
                        Rectangle()
                            .fill(m3.scrim.opacity(0.45))
                        PlayingIndicator(tint: .white)
                    }
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text(track.title)
                        .font(.m3TitleMedium.weight(.semibold))
                        .foregroundStyle(m3.onSurface)
                        .lineLimit(2)
                    Text(
                        [track.artistLine, track.durationLabel ?? ""]
                            .filter { !$0.isEmpty }
                            .joined(separator: " • ")
                    )
                    .font(.m3BodyMedium)
                    .foregroundStyle(m3.onSurfaceVariant)
                    .lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                ZStack {
                    Circle()
                        .fill(active ? m3.primary : m3.primaryContainer)
                    Image(systemName: active && player.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 19, weight: .semibold))
                        .foregroundStyle(active ? m3.onPrimary : m3.onPrimaryContainer)
                }
                .frame(width: 48, height: 48)
            }
            .padding(12)
            .frame(minHeight: 120)
            .background(m3.surfaceContainerHigh, in: M3Shape.dialog)
            .overlay {
                M3Shape.dialog
                    .strokeBorder(lineWidth: 1)
                    .foregroundStyle(m3.outlineVariant.opacity(0.9))
            }
            .frame(width: 320)
            .contentShape(M3Shape.dialog)
        }
        .buttonStyle(.plain)
        .pressScale(0.98)
    }

    // MARK: Suggested for you

    /// Android's CARD quick-picks: a full-bleed artwork hero carousel with
    /// the song title painted over the scrim — not a grid of tiles.
    @ViewBuilder private var suggestedForYou: some View {
        if !suggestionSnapshot.isEmpty {
            SectionHeader(title: "Suggested for you", menuItems: {
                Button("Reshuffle") {
                    library.reshuffleSuggestions()
                    snapshot()
                }
            })
            GeometryReader { proxy in
                let cardWidth = min(max(proxy.size.width - 48, 232), 440)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(
                            Array(suggestionSnapshot.prefix(visibleSuggestions).enumerated()),
                            id: \.element.id
                        ) { index, track in
                            HeroCard(track: track)
                                .frame(width: cardWidth)
                                .onAppear {
                                    // Prefetch the next page before the user hits it.
                                    if index >= visibleSuggestions - 6 { visibleSuggestions += 12 }
                                }
                        }
                    }
                    .padding(.horizontal, 16)
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.viewAligned)
            }
            .frame(height: 332)
        }
    }

    /// One hero card: artwork full-bleed under a bottom-weighted scrim, the
    /// title in white over it, and a now-playing pill in the top corner.
    private func HeroCard(track: Track) -> some View {
        let active = player.current?.videoId == track.videoId
        return Button {
            if active {
                player.togglePlayPause()
            } else {
                player.play(suggestionContext(for: track), startAt: 0)
            }
        } label: {
            ZStack(alignment: .bottomLeading) {
                ArtworkView(url: track.artwork, fallbackURL: track.artworkAlt, cornerRadius: 28)

                LinearGradient(
                    stops: [
                        .init(color: .clear, location: 0),
                        .init(color: .black.opacity(0.08), location: 0.48),
                        .init(color: .black.opacity(0.84), location: 1.0),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )

                VStack(alignment: .leading, spacing: 2) {
                    Text(track.title)
                        .font(.m3TitleLarge.weight(.semibold))
                        .foregroundStyle(.white)
                        .lineLimit(2)
                    Text(track.artistLine)
                        .font(.m3BodyLarge)
                        .foregroundStyle(.white.opacity(0.78))
                        .lineLimit(1)
                }
                .padding(20)
            }
            .overlay(alignment: .topTrailing) {
                if active {
                    ZStack {
                        Circle()
                            .fill(m3.primary)
                        Image(systemName: "speaker.wave.2.fill")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(m3.onPrimary)
                    }
                    .frame(width: 36, height: 36)
                    .padding(14)
                }
            }
            .clipShape(M3Shape.dialog)
            .contentShape(M3Shape.dialog)
        }
        .buttonStyle(.plain)
        .pressScale(0.98)
    }

    // MARK: Speed dial

    /// Android SpeedDialSection: paged 3x3 grid of pinned tiles sitting on a
    /// surfaceContainerLow rounded sheet, with expanding page dots underneath.
    /// Carmen's stand-in for "pinned" is the on-device playlists (up to 23
    /// tiles), with Android's ever-present "random" tile appended at the end.
    @ViewBuilder private var speedDial: some View {
        if !library.playlists.isEmpty {
            SectionHeader(title: "Speed dial")
            GeometryReader { proxy in
                let tile = SpeedDialGrid.tileSize(in: proxy.size.width)
                let tileCount = min(library.playlists.count, 23)
                SpeedDialGrid(
                    playlists: Array(library.playlists.prefix(23)),
                    shufflePool: shufflePool,
                    tile: tile,
                    height: SpeedDialGrid.height(tile: tile, tileCount: tileCount)
                )
            }
        }
    }

    // MARK: Forgotten favorites

    /// Android ForgottenFavoritesSection: favorites that haven't been played
    /// recently, in a snapping 4-row horizontal grid at 47.5% row width and
    /// standard 72pt list rows.
    private var forgottenFavoritesTracks: [Track] {
        let recentIDs = Set(recentSnapshot.map(\.videoId))
        var seen = Set<String>()
        return library.favorites.filter { !recentIDs.contains($0.videoId) && seen.insert($0.videoId).inserted }
    }

    @ViewBuilder private var forgottenFavorites: some View {
        if !forgottenFavoritesTracks.isEmpty {
            SectionHeader(title: "Forgotten favorites")
            GeometryReader { proxy in
                let itemWidth = proxy.size.width * 0.475
                let columns = [GridItem](repeating: GridItem(.fixed(M3Dim.listHeight), spacing: 0), count: 4)
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHGrid(rows: columns, spacing: 0) {
                        ForEach(Array(forgottenFavoritesTracks.prefix(24).enumerated()), id: \.element.id) { index, track in
                            ForgottenFavoriteRow(track: track, context: forgottenFavoritesTracks)
                                .frame(width: itemWidth)
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }
            .frame(height: M3Dim.listHeight * 4)
        }
    }

    // MARK: Remote home sections

    @ViewBuilder private var remote: some View {
        if remoteLoading, remoteSections.isEmpty {
            // First load: skeleton shaped like the shelves above while the
            // curated rows arrive.
            ShimmerGrid(items: 4, columns: 2)
                .padding(.horizontal, 16)
                .padding(.top, 4)
        } else {
            ForEach(remoteSections.filter { !$0.contents.isEmpty }) { section in
                remoteSection(section)
            }
        }
    }

    private func remoteSection(_ section: HomeSection) -> some View {
        let playable = playableTracks(section.contents)
        let playAll: (() -> Void)? = playable.isEmpty ? nil : { player.play(playable) }
        return VStack(alignment: .leading, spacing: 4) {
            SectionHeader(
                title: section.title,
                actionTitle: playAll == nil ? nil : "Play all",
                action: playAll
            )
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(section.contents) { card in
                        GridTile(card: card, siblings: section.contents)
                    }
                }
                .padding(.horizontal, 16)
            }
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
        snapshot()
        await loadRemote()
        // Minimum spinner so the control feels like it actually worked.
        try? await Task.sleep(for: .milliseconds(400))
    }

    /// Loads (or reloads) the curated `/browsing/home` rows. A failure only
    /// costs the remote sections — local content always stays on screen.
    private func loadRemote() async {
        remoteLoading = true
        do {
            remoteSections = try await API(baseURL: settings.apiBaseURL).home()
        } catch {
            DebugLog.log("home", "sections failed: \(error.localizedDescription)")
            remoteSections = []
        }
        remoteLoading = false
    }

    /// Frontend playSuggestion(): `[tapped] + (recents + shuffled suggestions
    /// minus the tapped track)`.
    private func suggestionContext(for tapped: Track) -> [Track] {
        var rest = recentSnapshot + suggestionSnapshot.shuffled()
        rest.removeAll { $0.videoId == tapped.videoId }
        return [tapped] + rest
    }

    /// The FAB: shuffle-play everything the local feed knows about.
    private func shuffleAll() {
        var seen = Set<String>()
        let candidates = (recentSnapshot + suggestionSnapshot)
            .filter { seen.insert($0.videoId).inserted }
        guard !candidates.isEmpty else { return }
        player.shuffle = true
        player.play(candidates.shuffled())
    }

    /// Pool behind the speed dial's "random" tile — the same local feed the
    /// FAB shuffles, so the tile mirrors Android's speed-dial random play.
    private var shufflePool: [Track] {
        var seen = Set<String>()
        return (recentSnapshot + suggestionSnapshot).filter { seen.insert($0.videoId).inserted }
    }
}

// MARK: - Speed dial grid (Android SpeedDialSection)

/// One entry in the speed-dial tile set. Android pins songs, albums, artists
/// and playlists; Carmen's pinned set is the on-device playlists plus the
/// ever-present "random" tile.
private enum SpeedDialEntry: Identifiable {
    case playlist(LocalPlaylist)
    case random

    var id: String {
        switch self {
        case .playlist(let playlist): return playlist.id.uuidString
        case .random: return "random"
        }
    }
}

/// Android's paged 3x3 tile grid: tiles on a surfaceContainerLow rounded
/// sheet (outer 12 + inner 12 padding), expanding page dots underneath.
private struct SpeedDialGrid: View {
    @Environment(Player.self) private var player
    @Environment(\.m3) private var m3

    let playlists: [LocalPlaylist]
    let shufflePool: [Track]
    let tile: CGFloat
    /// Whole-section height, computed by the caller so the wrapping
    /// GeometryReader can't truncate the sheet.
    let height: CGFloat

    static let spacing: CGFloat = 10

    /// Android: inner width (screen − 2×12 surface pad − 2×12 inner pad),
    /// tiles = (inner − spacing×(cols−1)) / cols.
    static func tileSize(in width: CGFloat) -> CGFloat {
        (width - 48 - spacing * 2) / 3
    }

    /// grid + 24 surface padding, plus the dot row (12 spacer + 8) when there
    /// is more than one page.
    static func height(tile: CGFloat, tileCount: Int) -> CGFloat {
        let pages = max(1, (tileCount + 1 + 8) / 9)
        let rows = pages == 1 ? min(3, (tileCount + 1 + 2) / 3) : 3
        let grid = tile * CGFloat(rows) + spacing * CGFloat(rows - 1)
        var total = grid + 24
        if pages > 1 { total += 20 }
        return total
    }

    var body: some View {
        let tiles = playlists.map(SpeedDialEntry.playlist) + [.random]
        let pages = stride(from: 0, to: tiles.count, by: 9).map { Array(tiles[$0..<min($0 + 9, tiles.count)]) }
        // pagers row height: 24 sheet padding, plus 12 gap + 8 dots when paged.
        let pagerHeight = height - 24 - (pages.count > 1 ? 20 : 0)
        return VStack(spacing: 12) {
            TabView(selection: $page) {
                ForEach(pages.indices, id: \.self) { pageIndex in
                    let pageTiles = pages[pageIndex]
                    let rows = max(1, Int(ceil(Double(pageTiles.count) / 3)))
                    VStack(spacing: Self.spacing) {
                        ForEach(0..<rows, id: \.self) { row in
                            HStack(spacing: Self.spacing) {
                                ForEach(0..<3, id: \.self) { column in
                                    let index = row * 3 + column
                                    if index < pageTiles.count {
                                        dialTile(pageTiles[index])
                                    } else {
                                        Color.clear
                                            .frame(width: tile, height: tile)
                                    }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 12)
                    .frame(maxWidth: .infinity)
                    .tag(pageIndex)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .frame(height: pagerHeight)

            if pages.count > 1 {
                HStack(spacing: 8) {
                    ForEach(pages.indices, id: \.self) { index in
                        Capsule()
                            .fill(index == page ? m3.primary : m3.surfaceContainerHighest)
                            .frame(width: index == page ? 22 : 8, height: 8)
                            .animation(.easeInOut(duration: 0.2), value: page)
                    }
                }
            }
        }
        .padding(.vertical, 12)
        .background(m3.surface, in: M3Shape.large)
    }

    @State private var page = 0

    @ViewBuilder private func dialTile(_ entry: SpeedDialEntry) -> some View {
        switch entry {
        case .playlist(let playlist):
            SpeedDialPlaylistTile(playlist: playlist, size: tile)
        case .random:
            Button {
                guard let first = shufflePool.randomElement() else { return }
                player.play(shufflePool, startAt: shufflePool.firstIndex(of: first) ?? 0)
            } label: {
                ZStack {
                    Rectangle()
                        .fill(m3.surfaceContainerHighest)
                    Image(systemName: "shuffle")
                        .font(.system(size: 22, weight: .medium))
                        .foregroundStyle(m3.onSurfaceVariant)
                }
                .frame(width: tile, height: tile)
                .clipShape(M3Shape.large)
            }
            .buttonStyle(.plain)
            .pressScale(0.96)
        }
    }
}

/// One speed-dial tile: artwork full-bleed, a bottom-weighted label
/// gradient (transparent → 34% → 78% black), the name in labelLarge white
/// with a chevron (non-song tiles navigate) and a bookmark badge up top —
/// Android SpeedDialGridItem, pinned variant.
private struct SpeedDialPlaylistTile: View {
    @Environment(Player.self) private var player
    @Environment(\.m3) private var m3

    let playlist: LocalPlaylist
    let size: CGFloat

    var body: some View {
        Button {
            if !playlist.tracks.isEmpty {
                player.play(playlist.tracks)
            }
        } label: {
            ZStack(alignment: .bottomLeading) {
                ArtworkView(
                    url: playlist.tracks.first?.artwork,
                    fallbackURL: playlist.tracks.first?.artworkAlt,
                    cornerRadius: 0
                )

                LinearGradient(
                    stops: [
                        .init(color: .clear, location: 0),
                        .init(color: .black.opacity(0.34), location: 0.55),
                        .init(color: .black.opacity(0.78), location: 1.0),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: min(86, size * 0.8))
                .frame(maxHeight: .infinity, alignment: .bottom)

                HStack(spacing: 4) {
                    Text(playlist.name)
                        .font(.m3LabelLarge.weight(.semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                }
                .padding(.leading, 10)
                .padding(.trailing, 6)
                .padding(.bottom, 8)

                Image(systemName: "bookmark.fill")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(.white)
                    .padding(9)
            }
            .frame(width: size, height: size)
            .clipShape(M3Shape.large)
            .contentShape(M3Shape.large)
        }
        .buttonStyle(.plain)
        .pressScale(0.96)
        .disabled(playlist.tracks.isEmpty)
    }
}

/// One forgotten-favorites list row — Android SongListItem at 47.5% width:
/// 48pt artwork, title + artist, tap toggles/plays in the row's own context.
private struct ForgottenFavoriteRow: View {
    @Environment(Player.self) private var player
    @Environment(\.m3) private var m3

    let track: Track
    let context: [Track]

    var body: some View {
        Button {
            if player.current?.videoId == track.videoId {
                player.togglePlayPause()
            } else if let index = context.firstIndex(where: { $0.videoId == track.videoId }) {
                player.play(context, startAt: index)
            }
        } label: {
            HStack(spacing: 12) {
                ArtworkView(url: track.artwork, fallbackURL: track.artworkAlt, cornerRadius: 8)
                    .frame(width: 48, height: 48)

                VStack(alignment: .leading, spacing: 2) {
                    Text(track.title)
                        .font(.m3BodyLarge.weight(.medium))
                        .foregroundStyle(m3.onSurface)
                        .lineLimit(1)
                    Text(track.artistLine)
                        .font(.m3BodyMedium)
                        .foregroundStyle(m3.onSurfaceVariant)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
