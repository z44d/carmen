//
//  DetailViews.swift
//  Carmen — the pushed detail screens: album, artist and playlist.
//
//  Material 3 rebuild of the old DetailHeader screens. All three share
//  `DetailHero` (artwork + title + tappable artist line + metadata bullets
//  + the Shuffle/Play/Add action row) and the same load-in-`.task` shape:
//  ShimmerList → detail, or M3ErrorState with a retry. The native inline
//  navigation bar keeps the back button; the kebab lives in the toolbar and
//  the hero sits in the scroll content under a primaryContainer wash —
//  the same anatomy as Android's MediaDetailHero.
//

import SwiftUI
import UIKit

// MARK: - Shared hero

/// Big artwork, title, tappable artist names, bullet-joined metadata line
/// and the Shuffle / Play / “Add” row every detail screen opens with.
///
/// `trailing` is the per-screen icon next to Add — the header download ring
/// on the album screen, a ShareLink on playlists, nothing on artists.
private struct DetailHero<Trailing: View>: View {
    let title: String
    var artworkURL: String?
    var placeholderSymbol: String = "music.note"
    /// Artist pages paint their art full-width (Android's banner hero);
    /// albums/playlists get the 180pt r16 square.
    var bannerArtwork: Bool = false
    /// Artist refs rendered as links — non-empty ids push the artist screen.
    var artists: [ArtistRef] = []
    /// “2015 · 12 songs · 48:12” — only the fields the payload gave us.
    var metaParts: [String] = []
    let tracks: [Track]
    /// The Add icon adds `tracks.first`; artists don't offer it.
    var showAddAction: Bool = true

    private let trailingContent: AnyView

    @Environment(\.m3) private var m3
    @Environment(Player.self) private var player

    init(
        title: String,
        artworkURL: String?,
        placeholderSymbol: String = "music.note",
        bannerArtwork: Bool = false,
        artists: [ArtistRef] = [],
        metaParts: [String] = [],
        tracks: [Track],
        showAddAction: Bool = true,
        @ViewBuilder trailing: () -> Trailing = { EmptyView() }
    ) {
        self.title = title
        self.artworkURL = artworkURL
        self.placeholderSymbol = placeholderSymbol
        self.bannerArtwork = bannerArtwork
        self.artists = artists
        self.metaParts = metaParts
        self.tracks = tracks
        self.showAddAction = showAddAction
        self.trailingContent = AnyView(trailing())
    }

    var body: some View {
        VStack(spacing: 14) {
            artwork
            VStack(spacing: 8) {
                Text(title)
                    .font(.m3HeadlineMedium)
                    .foregroundStyle(m3.onSurface)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
                    .frame(maxWidth: .infinity)
                if !artists.isEmpty || !metaParts.isEmpty {
                    metaLine
                }
                if !tracks.isEmpty {
                    actionBar
                        .padding(.top, 6)
                }
            }
            .padding(.horizontal, 16)
        }
        .padding(.top, bannerArtwork ? 0 : 8)
    }

    @ViewBuilder private var artwork: some View {
        if bannerArtwork {
            ArtworkView(
                url: artworkURL,
                fallbackURL: nil,
                cornerRadius: 0,
                placeholderSymbol: placeholderSymbol
            )
            .frame(height: 220)
            .frame(maxWidth: .infinity)
            .overlay(alignment: .bottom) {
                LinearGradient(
                    colors: [.clear, m3.background],
                    startPoint: .top,
                    endPoint: .bottom
                )
            }
        } else {
            ArtworkView(
                url: artworkURL,
                fallbackURL: nil,
                cornerRadius: 16,
                placeholderSymbol: placeholderSymbol
            )
            .frame(width: 180, height: 180)
            .shadow(color: m3.scrim.opacity(0.18), radius: 12, y: 6)
        }
    }

    // MARK: Metadata line — “Artist1, Artist2 · 2015 · 12 songs · 48:12”

    private var metaLine: some View {
        HStack(spacing: 4) {
            artistRun
            ForEach(Array(metaParts.enumerated()), id: \.offset) { pair in
                if !artists.isEmpty || pair.offset > 0 {
                    bullet
                }
                Text(pair.element)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
        }
        .font(.m3BodySmall)
        .foregroundStyle(m3.onSurfaceVariant)
        .lineLimit(1)
        .minimumScaleFactor(0.75)
        .frame(maxWidth: .infinity)
    }

    private var bullet: some View {
        Text("·")
            .foregroundStyle(m3.onSurfaceVariant.opacity(0.7))
    }

    @ViewBuilder private var artistRun: some View {
        ForEach(Array(artists.enumerated()), id: \.offset) { pair in
            if pair.offset > 0 {
                Text(",")
            }
            if let id = pair.element.id, !id.isEmpty {
                NavigationLink(value: Route.artist(channelId: id, title: pair.element.name)) {
                    Text(pair.element.name)
                        .font(.m3BodySmall.weight(.medium))
                        .foregroundStyle(m3.primary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }
                .buttonStyle(.plain)
            } else {
                Text(pair.element.name)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
        }
    }

    // MARK: Actions — Shuffle (tonal) + Play (filled accent) + Add + trailing

    private var actionBar: some View {
        HStack(spacing: 12) {
            Button {
                player.shuffle = true
                player.play(tracks.shuffled())
            } label: {
                Label("Shuffle", systemImage: "shuffle")
            }
            .buttonStyle(M3TonalStyle(compact: true))

            Button {
                player.play(tracks)
            } label: {
                Label("Play", systemImage: "play.fill")
            }
            .buttonStyle(M3FilledStyle(fill: .carmen, compact: true))

            if showAddAction, let first = tracks.first {
                // Same nesting the sheet menu uses: the picker is itself a
                // Menu, so it becomes a submenu of this one.
                Menu {
                    PlaylistPickerMenu(track: first)
                } label: {
                    Image(systemName: "music.note.list")
                        .font(.m3(18, weight: .medium))
                        .frame(width: 40, height: 40)
                        .contentShape(Circle())
                }
                .accessibilityLabel("Add to Playlist")
            }

            trailingContent
        }
    }
}

// MARK: - Hero download (album header)

/// Aggregate download control for a whole album — Android's header download
/// action. One tap queues every track that isn't saved yet; when the whole
/// header is saved, a tap removes them all. The ring reports the share of
/// tracks already on disk.
private struct HeroDownloadButton: View {
    let tracks: [Track]

    @Environment(DownloadsStore.self) private var downloads

    private var downloadedCount: Int {
        tracks.filter { downloads.isDownloaded($0.videoId) }.count
    }

    private var isRunning: Bool {
        tracks.contains { downloads.state(for: $0.videoId) != nil }
    }

    var body: some View {
        Button {
            if !tracks.isEmpty, downloadedCount == tracks.count {
                for track in tracks { downloads.remove(videoId: track.videoId) }
            } else {
                for track in tracks where !downloads.isDownloaded(track.videoId) {
                    downloads.download(track)
                }
            }
        } label: {
            label
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(downloadedCount == tracks.count && !tracks.isEmpty ? "Remove Download" : "Download")
    }

    @ViewBuilder private var label: some View {
        let progress = tracks.isEmpty ? 0 : Double(downloadedCount) / Double(tracks.count)
        if !tracks.isEmpty, progress >= 1 {
            Image(systemName: "checkmark.circle.fill")
                .font(.m3(24, weight: .medium))
                .foregroundStyle(Color.carmen)
        } else if isRunning || progress > 0 {
            ZStack {
                Circle()
                    .stroke(Color.secondary.opacity(0.25), lineWidth: 2)
                Circle()
                    .trim(from: 0, to: max(progress, 0.02))
                    .stroke(Color.carmen, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            .frame(width: 24, height: 24)
        } else {
            Image(systemName: "arrow.down.circle")
                .font(.m3(24, weight: .medium))
                .foregroundStyle(Color.secondary)
        }
    }
}

// MARK: - Shared description

/// Secondary description text, clamped to `lines` with a More/Less toggle
/// once it actually gets long (behavior ported from the old ExpandableText).
private struct ExpandableText: View {
    let text: String
    var lines: Int = 4

    @State private var expanded = false
    @Environment(\.m3) private var m3

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(text)
                .font(.m3BodyMedium)
                .foregroundStyle(m3.onSurfaceVariant)
                .lineLimit(expanded ? nil : lines)
                .frame(maxWidth: .infinity, alignment: .leading)
            if text.count > 160 {
                Button(expanded ? "Less" : "More") {
                    withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
                }
                .font(.m3LabelLarge)
                .foregroundStyle(m3.primary)
            }
        }
        .padding(.horizontal, 16)
    }
}

// MARK: - Album

struct AlbumView: View {
    let browseId: String
    let title: String

    @State private var detail: AlbumDetail?
    @State private var errorMessage: String?

    @Environment(\.m3) private var m3
    @Environment(Player.self) private var player

    private var shareLink: String { "https://carmen.z44d.com/?album=\(browseId)" }

    var body: some View {
        content
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let detail {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button {
                                player.play(detail.tracks)
                            } label: {
                                Label("Play All", systemImage: "play.fill")
                            }
                            Button {
                                player.shuffle = true
                                player.play(detail.tracks.shuffled())
                            } label: {
                                Label("Shuffle", systemImage: "shuffle")
                            }
                            ShareLink(item: shareLink) {
                                Label("Share", systemImage: "square.and.arrow.up")
                            }
                        } label: {
                            Image(systemName: "ellipsis")
                                .font(.m3(20, weight: .semibold))
                        }
                    }
                }
            }
            .task(id: browseId) {
                await load()
            }
    }

    @ViewBuilder private var content: some View {
        if let detail {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    DetailHero(
                        title: detail.title,
                        artworkURL: detail.artworkURL,
                        placeholderSymbol: "square.stack",
                        artists: albumArtists(detail),
                        metaParts: metaParts(detail),
                        tracks: detail.tracks
                    ) {
                        HeroDownloadButton(tracks: detail.tracks)
                    }
                    if let description = detail.description, !description.isEmpty {
                        ExpandableText(text: description)
                    }
                    trackList(album: detail)
                }
                .padding(.bottom, 32)
                .frame(maxWidth: .infinity)
                .background(alignment: .top) { HeroWash() }
            }
            .background(m3.background)
        } else if let errorMessage {
            ScrollView {
                M3ErrorState(message: errorMessage) {
                    Task { await load() }
                }
            }
        } else {
            ScrollView {
                ShimmerList(rows: 6)
                    .padding(.top, 12)
            }
        }
    }

    /// Android's hero subtitle: linked artists, falling back to the author.
    private func albumArtists(_ album: AlbumDetail) -> [ArtistRef] {
        if !album.artists.isEmpty { return album.artists }
        if let author = album.author, !author.isEmpty { return [ArtistRef(name: author)] }
        return []
    }

    private func load() async {
        errorMessage = nil
        do {
            detail = try await API(baseURL: SettingsStore.shared.apiBaseURL).album(browseId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func trackList(album: AlbumDetail) -> some View {
        LazyVStack(spacing: 0) {
            ForEach(Array(album.tracks.enumerated()), id: \.offset) { pair in
                ListRow(
                    track: pair.element,
                    isPlaying: player.current?.videoId == pair.element.videoId,
                    index: pair.offset + 1,
                    showArtwork: false,
                    onTap: { player.play(album.tracks, startAt: pair.offset) }
                )
                .padding(.horizontal, 8)
            }
        }
    }

    /// “2015 · 12 songs · 48:12” — whatever the payload gave us.
    private func metaParts(_ album: AlbumDetail) -> [String] {
        var parts: [String] = []
        if let year = album.year, !year.isEmpty { parts.append(year) }
        let count = album.trackCount ?? album.tracks.count
        if count > 0 { parts.append("\(count) songs") }
        if let duration = album.duration, !duration.isEmpty {
            parts.append(duration)
        } else {
            let total = album.tracks.reduce(0) { $0 + ($1.durationSeconds ?? 0) }
            if total > 0, let label = formatDuration(total) { parts.append(label) }
        }
        return parts
    }
}

// MARK: - Artist

struct ArtistView: View {
    let channelId: String
    let title: String

    @State private var detail: ArtistDetail?
    @State private var errorMessage: String?

    @Environment(\.m3) private var m3
    @Environment(Player.self) private var player

    private var shareLink: String { "https://carmen.z44d.com/?artist=\(channelId)" }

    var body: some View {
        content
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        ShareLink(item: shareLink) {
                            Label("Share", systemImage: "square.and.arrow.up")
                        }
                        Button {
                            UIPasteboard.general.string = shareLink
                        } label: {
                            Label("Copy Link", systemImage: "link")
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.m3(20, weight: .semibold))
                    }
                }
            }
            .task(id: channelId) {
                await load()
            }
    }

    @ViewBuilder private var content: some View {
        if let detail {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    DetailHero(
                        title: detail.name,
                        artworkURL: detail.artworkURL,
                        placeholderSymbol: "person.crop.square",
                        bannerArtwork: true,
                        metaParts: statsParts(detail),
                        tracks: detail.songs,
                        showAddAction: false
                    )
                    if let description = detail.description, !description.isEmpty {
                        ExpandableText(text: description)
                    }
                    if !detail.songs.isEmpty {
                        popularSection(artist: detail)
                    }
                    cardShelf("Albums", detail.albums)
                    cardShelf("Singles", detail.singles)
                    cardShelf("Related Artists", detail.related)
                }
                .padding(.bottom, 32)
                .frame(maxWidth: .infinity)
                .background(alignment: .top) { HeroWash() }
            }
            .background(m3.background)
        } else if let errorMessage {
            ScrollView {
                M3ErrorState(message: errorMessage) {
                    Task { await load() }
                }
            }
        } else {
            ScrollView {
                ShimmerList(rows: 6)
                    .padding(.top, 12)
            }
        }
    }

    private func load() async {
        errorMessage = nil
        do {
            detail = try await API(baseURL: SettingsStore.shared.apiBaseURL).artist(channelId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// “1.2M subscribers · 8.4M monthly listeners” — whatever the payload gave.
    private func statsParts(_ artist: ArtistDetail) -> [String] {
        [artist.subscribers, artist.monthlyListeners]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
    }

    private func popularSection(artist: ArtistDetail) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionHeader(title: "Popular")
            ForEach(Array(artist.songs.enumerated()), id: \.offset) { pair in
                ListRow(
                    track: pair.element,
                    isPlaying: player.current?.videoId == pair.element.videoId,
                    onTap: { player.play(artist.songs, startAt: pair.offset) }
                )
                .padding(.horizontal, 8)
            }
        }
    }

    @ViewBuilder private func cardShelf(_ title: String, _ cards: [MediaCard]) -> some View {
        if !cards.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(title: title)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: 14) {
                        ForEach(cards) { card in
                            GridTile(card: card, siblings: cards, width: 140)
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }
        }
    }
}

// MARK: - Playlist

struct PlaylistView: View {
    let playlistId: String
    let title: String

    @State private var detail: PlaylistDetail?
    @State private var errorMessage: String?

    @Environment(\.m3) private var m3
    @Environment(Player.self) private var player

    /// Playlist browse ids may arrive VL-prefixed — the API (and the web
    /// share links) want the bare id.
    private var bareId: String {
        playlistId.hasPrefix("VL") ? String(playlistId.dropFirst(2)) : playlistId
    }

    private var shareLink: String { "https://carmen.z44d.com/?playlist=\(bareId)" }

    var body: some View {
        content
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let detail {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button {
                                player.play(detail.tracks)
                            } label: {
                                Label("Play All", systemImage: "play.fill")
                            }
                            Button {
                                player.shuffle = true
                                player.play(detail.tracks.shuffled())
                            } label: {
                                Label("Shuffle", systemImage: "shuffle")
                            }
                            ShareLink(item: shareLink) {
                                Label("Share", systemImage: "square.and.arrow.up")
                            }
                        } label: {
                            Image(systemName: "ellipsis")
                                .font(.m3(20, weight: .semibold))
                        }
                    }
                }
            }
            .task(id: playlistId) {
                await load()
            }
    }

    @ViewBuilder private var content: some View {
        if let detail {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    DetailHero(
                        title: detail.title,
                        artworkURL: detail.artworkURL,
                        placeholderSymbol: "music.note.list",
                        metaParts: metaParts(detail),
                        tracks: detail.tracks
                    ) {
                        ShareLink(item: shareLink) {
                            Image(systemName: "square.and.arrow.up")
                                .font(.m3(18, weight: .medium))
                                .frame(width: 40, height: 40)
                                .foregroundStyle(m3.onSurfaceVariant)
                                .contentShape(Circle())
                        }
                    }
                    if let description = detail.description, !description.isEmpty {
                        ExpandableText(text: description)
                    }
                    trackList(playlist: detail)
                }
                .padding(.bottom, 32)
                .frame(maxWidth: .infinity)
                .background(alignment: .top) { HeroWash() }
            }
            .background(m3.background)
        } else if let errorMessage {
            ScrollView {
                M3ErrorState(message: errorMessage) {
                    Task { await load() }
                }
            }
        } else {
            ScrollView {
                ShimmerList(rows: 6)
                    .padding(.top, 12)
            }
        }
    }

    private func load() async {
        errorMessage = nil
        do {
            detail = try await API(baseURL: SettingsStore.shared.apiBaseURL).playlist(bareId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// “YouTube Music · 42 songs” — owner and count, only when present.
    private func metaParts(_ playlist: PlaylistDetail) -> [String] {
        var parts: [String] = []
        if let author = playlist.author, !author.isEmpty { parts.append(author) }
        let count = playlist.trackCount ?? playlist.tracks.count
        if count > 0 { parts.append("\(count) songs") }
        return parts
    }

    private func trackList(playlist: PlaylistDetail) -> some View {
        LazyVStack(spacing: 0) {
            ForEach(Array(playlist.tracks.enumerated()), id: \.offset) { pair in
                ListRow(
                    track: pair.element,
                    isPlaying: player.current?.videoId == pair.element.videoId,
                    onTap: { player.play(playlist.tracks, startAt: pair.offset) }
                )
                .padding(.horizontal, 8)
            }
        }
    }
}

/// A podcast show (`/podcasts/podcast/{playlistId}`): `DetailHero` header
/// plus the episodes as playable rows — Android's podcast detail screen.
struct PodcastView: View {
    let playlistId: String
    let title: String

    @State private var detail: PodcastDetail?
    @State private var errorMessage: String?

    @Environment(\.m3) private var m3
    @Environment(Player.self) private var player
    @Environment(LibraryStore.self) private var library

    private var shareLink: String { "https://carmen.z44d.com/?podcast=\(playlistId)" }

    var body: some View {
        content
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let detail {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button {
                                player.play(detail.episodes)
                            } label: {
                                Label("Play All", systemImage: "play.fill")
                            }
                            ShareLink(item: shareLink) {
                                Label("Share", systemImage: "square.and.arrow.up")
                            }
                        } label: {
                            Image(systemName: "ellipsis")
                                .font(.m3(20, weight: .semibold))
                        }
                    }
                }
            }
            .task(id: playlistId) {
                await load()
            }
    }

    @ViewBuilder private var content: some View {
        if let detail {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    DetailHero(
                        title: detail.title,
                        artworkURL: detail.artworkURL,
                        placeholderSymbol: "mic",
                        metaParts: metaParts(detail),
                        tracks: detail.episodes
                    ) {
                        ShareLink(item: shareLink) {
                            Image(systemName: "square.and.arrow.up")
                                .font(.m3(18, weight: .medium))
                                .frame(width: 40, height: 40)
                                .foregroundStyle(m3.onSurfaceVariant)
                                .contentShape(Circle())
                        }
                    }
                    if let description = detail.description, !description.isEmpty {
                        ExpandableText(text: description)
                    }
                    episodeList(show)
                }
                .padding(.bottom, 32)
                .frame(maxWidth: .infinity)
                .background(alignment: .top) { HeroWash() }
            }
            .background(m3.background)
        } else if let errorMessage {
            ScrollView {
                M3ErrorState(message: errorMessage) {
                    Task { await load() }
                }
            }
        } else {
            ScrollView {
                ShimmerList(rows: 6)
                    .padding(.top, 12)
            }
        }
    }

    /// Voids previewing with a load-in-flight that then replaces `detail`.
    private func load() async {
        errorMessage = nil
        do {
            detail = try await API(baseURL: SettingsStore.shared.apiBaseURL).podcast(playlistId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// “Author · 12 episodes” — show author and episode count.
    private func metaParts(_ show: PodcastDetail) -> [String] {
        var parts: [String] = []
        if !show.author.isEmpty { parts.append(show.author) }
        if !show.episodes.isEmpty {
            parts.append(show.episodes.count == 1 ? "1 episode" : "\(show.episodes.count) episodes")
        }
        return parts
    }

    private func episodeList(_ show: PodcastDetail) -> some View {
        LazyVStack(spacing: 0) {
            ForEach(Array(show.episodes.enumerated()), id: \.offset) { pair in
                ListRow(
                    track: pair.element,
                    isPlaying: player.current?.videoId == pair.element.videoId,
                    onTap: { player.play(show.episodes, startAt: pair.offset) }
                )
                .padding(.horizontal, 8)
            }
        }
    }
}

// MARK: - Shared hero wash

/// Android's hero background: a wash of the primary container fading into
/// the page background behind the artwork, title and actions.
private struct HeroWash: View {
    @Environment(\.m3) private var m3

    var body: some View {
        LinearGradient(
            colors: [m3.primaryContainer.opacity(0.3), m3.background],
            startPoint: .top,
            endPoint: .bottom
        )
        .frame(height: 520)
        .ignoresSafeArea(edges: .top)
    }
}
