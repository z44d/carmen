//
//  Rows.swift
//  Carmen — the Material list/grid vocabulary.
//
//  Android's `Items.kt` equivalents: ListRow is the 72pt list item (56pt
//  rounded-square thumb, two text lines, trailing actions), GridTile is the
//  128pt grid card (bold title, secondary subtitle, optional play overlay,
//  circular variant for artists), SectionHeader carries the "Play all"
//  action, and PlayingIndicator is the animated bars badge.
//

import SwiftUI

// MARK: - Now-playing bars

/// Four animated bars shown on the currently playing row. Pauses with the
/// player; renders static when playback is stopped.
struct PlayingIndicator: View {
    var tint: Color?

    @Environment(Player.self) private var player
    @Environment(\.m3) private var m3

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { context in
            let time = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 2.5) {
                ForEach(0..<4, id: \.self) { index in
                    let wave = (sin(time * 6.5 + Double(index) * 1.2) + 1) / 2
                    let height: CGFloat = player.isPlaying ? 5 + CGFloat(wave) * 11 : 5
                    Capsule()
                        .fill(tint ?? m3.primary)
                        .frame(width: 3, height: height)
                }
            }
        }
        .frame(width: 22, height: 20)
        .accessibilityLabel("Now playing")
    }
}

// MARK: - List row

/// One row of a song list — Android's `ListItem` (72pt / 56pt thumb / r10).
/// Tapping runs `onTap` (screens decide the play context); the kebab opens
/// the Material bottom-sheet menu, and the trailing download control is the
/// same store-driven ring as before.
struct ListRow: View {
    var track: Track
    /// Marks the row as the current track (secondary-container wash + bars).
    var isPlaying: Bool = false
    /// Index shown instead of artwork when `showArtwork` is false.
    var index: Int? = nil
    var showArtwork: Bool = true
    var showDuration: Bool = true
    var showDownload: Bool = true
    var showMenu: Bool = true
    var onTap: (() -> Void)? = nil

    @Environment(\.m3) private var m3
    @State private var showSheet = false

    var body: some View {
        HStack(spacing: 12) {
            leading
                .frame(width: M3Dim.listThumb, height: M3Dim.listThumb)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(track.title)
                        .font(.m3BodyLarge.weight(.medium))
                        .lineLimit(1)
                        .foregroundStyle(isPlaying ? m3.primary : m3.onSurface)
                    if track.isExplicit { ExplicitBadge() }
                }
                Text(track.artistLine)
                    .font(.m3BodySmall)
                    .foregroundStyle(m3.onSurfaceVariant)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if showDuration, let duration = track.durationLabel, !duration.isEmpty {
                Text(duration)
                    .font(.m3BodySmall)
                    .monospacedDigit()
                    .foregroundStyle(m3.onSurfaceVariant)
            }

            if showDownload {
                DownloadButton(track: track, diameter: 20)
            }

            if showMenu {
                Button {
                    showSheet = true
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(width: 32, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(m3.onSurfaceVariant)
                .accessibilityLabel("More options")
            }
        }
        .padding(.horizontal, 16)
        .frame(height: M3Dim.listHeight)
        .background(
            isPlaying ? m3.secondaryContainer.opacity(0.55) : Color.clear,
            in: M3Shape.card
        )
        .contentShape(Rectangle())
        .onTapGesture { onTap?() }
        .bottomSheetMenu(isPresented: $showSheet, title: track.title) {
            TrackSheetMenu(track: track)
        }
    }

    @ViewBuilder private var leading: some View {
        if showArtwork {
            ZStack {
                ArtworkView(url: track.artwork, fallbackURL: track.artworkAlt, cornerRadius: 10)
                if isPlaying {
                    Rectangle()
                        .fill(m3.scrim.opacity(0.45))
                    PlayingIndicator()
                }
            }
        } else if let index {
            Text("\(index)")
                .font(.m3BodyLarge)
                .foregroundStyle(m3.onSurfaceVariant)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

// MARK: - Bottom-sheet track menu

/// The song menu Android shows in its BottomSheetMenu — same entries as the
/// old context menu, now Material rows. Presented inside a sheet's own
/// NavigationStack, so "Go to …" pushes work from wherever it opens.
struct TrackSheetMenu: View {
    var track: Track

    @Environment(Player.self) private var player
    @Environment(LibraryStore.self) private var library

    var body: some View {
        SheetMenuRow(title: "Play Next", systemImage: "text.insert") {
            player.playNext(track)
        }
        SheetMenuRow(title: "Add to Queue", systemImage: "list.bullet.plus") {
            player.enqueue(track)
        }
        SheetMenuRow(
            title: library.isFavorite(track.videoId) ? "Remove Favorite" : "Favorite",
            systemImage: library.isFavorite(track.videoId) ? "heart.slash" : "heart"
        ) {
            library.toggleFavorite(track)
        }
        SheetMenuRow(title: "Play Radio", systemImage: "dot.radiowaves.left.and.right") {
            player.playStation(seed: track)
        }
        // The picker is itself a Menu — nested exactly like the old
        // context-menu did, so it becomes a submenu of this sheet.
        Menu {
            PlaylistPickerMenu(track: track)
        } label: {
            SheetMenuRowLabel(title: "Add to Playlist…", systemImage: "music.note.list")
        }
        Divider()
        DownloadMenuItems(track: track)
        if let albumId = track.album?.id, !albumId.isEmpty {
            NavigationLink(value: Route.album(browseId: albumId, title: track.albumName)) {
                SheetMenuRowLabel(title: "Go to Album", systemImage: "square.stack")
            }
        }
        if let artistId = track.artists.first(where: { !($0.id ?? "").isEmpty })?.id {
            NavigationLink(value: Route.artist(channelId: artistId, title: track.artists.first?.name ?? "")) {
                SheetMenuRowLabel(title: "Go to Artist", systemImage: "person.crop.circle")
            }
        }
        ShareLink(item: "https://carmen.z44d.com/?song=\(track.videoId)") {
            SheetMenuRowLabel(title: "Share", systemImage: "square.and.arrow.up")
        }
    }
}

// MARK: - Grid tile

/// Android's `GridItem`: 128pt thumbnail (r8, or a circle for artists), bold
/// two-line title, secondary subtitle, optional play overlay. The card and
/// track conveniences carry the old CardTile routing (play in context /
/// push route / start station) so screens just drop them in a LazyVGrid.
struct GridTile: View {
    enum Source {
        case plain
        case card(MediaCard, siblings: [MediaCard])
        case track(Track, context: [Track])
    }

    var title: String = ""
    var subtitle: String = ""
    var artwork: String? = nil
    var artworkAlt: String? = nil
    var isCircular: Bool = false
    var showPlayOverlay: Bool = false
    var isExplicit: Bool = false
    var width: CGFloat = M3Dim.gridThumb
    var source: Source = .plain
    var action: () -> Void = {}

    @Environment(\.m3) private var m3
    @Environment(Player.self) private var player

    /// Display-only tile (categories, playlists built by hand).
    init(
        title: String,
        subtitle: String,
        artwork: String? = nil,
        artworkAlt: String? = nil,
        isCircular: Bool = false,
        showPlayOverlay: Bool = false,
        isExplicit: Bool = false,
        width: CGFloat = M3Dim.gridThumb,
        action: @escaping () -> Void = {}
    ) {
        self.title = title
        self.subtitle = subtitle
        self.artwork = artwork
        self.artworkAlt = artworkAlt
        self.isCircular = isCircular
        self.showPlayOverlay = showPlayOverlay
        self.isExplicit = isExplicit
        self.width = width
        self.source = .plain
        self.action = action
    }

    /// Feed tile: songs play in their row context, albums/artists/playlists
    /// push their screen, stations start a radio queue (old CardTile rules).
    init(card: MediaCard, siblings: [MediaCard] = [], width: CGFloat = M3Dim.gridThumb) {
        self.title = card.title
        self.subtitle = card.subtitle
        self.artwork = card.artwork
        self.artworkAlt = card.artworkAlt
        self.isCircular = card.kind == .artist
        self.isExplicit = card.isExplicit && card.kind == .song
        self.width = width
        self.source = .card(card, siblings: siblings)
        self.action = {}
    }

    /// A song tile that plays inside its context.
    init(track: Track, context: [Track] = [], showPlayOverlay: Bool = true, width: CGFloat = M3Dim.gridThumb) {
        self.title = track.title
        self.subtitle = track.artistLine
        self.artwork = track.artwork
        self.artworkAlt = track.artworkAlt
        self.showPlayOverlay = showPlayOverlay
        self.isExplicit = track.isExplicit
        self.width = width
        self.source = .track(track, context: context)
        self.action = {}
    }

    var body: some View {
        switch source {
        case .plain:
            Button(action: action) { content }
                .buttonStyle(.plain)
        case .card(let card, let siblings):
            cardRouting(card, siblings: siblings)
        case .track(let track, let context):
            Button {
                var queue = context
                if queue.isEmpty { queue = [track] }
                let startAt = queue.firstIndex { $0.videoId == track.videoId } ?? 0
                player.play(queue, startAt: startAt)
            } label: { content }
                .buttonStyle(.plain)
        }
    }

    @ViewBuilder private func cardRouting(_ card: MediaCard, siblings: [MediaCard]) -> some View {
        if let track = card.track, card.kind == .song {
            Button {
                var context = playableTracks(siblings)
                if context.isEmpty { context = [track] }
                let startAt = context.firstIndex { $0.videoId == track.videoId } ?? 0
                player.play(context, startAt: startAt)
            } label: { content }
                .buttonStyle(.plain)
        } else if let route = Route(card: card) {
            NavigationLink(value: route) { content }
                .buttonStyle(.plain)
        } else {
            Button {
                if card.kind == .station, !card.targetId.isEmpty {
                    player.playWatch(playlistId: card.targetId)
                }
            } label: { content }
                .buttonStyle(.plain)
        }
    }

    /// Kind-aware placeholder (old CardTile's rule: artists show a person
    /// square, playlists/stations a list, albums a stack).
    private var placeholderSymbol: String {
        if case .card(let card, _) = source {
            switch card.kind {
            case .artist: return "person.crop.square"
            case .playlist, .station: return "music.note.list"
            case .album: return "square.stack"
            case .song, .unsupported: return "music.note"
            }
        }
        return isCircular ? "person.crop.square" : "music.note"
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .bottomTrailing) {
                ArtworkView(
                    url: artwork,
                    fallbackURL: artworkAlt,
                    cornerRadius: isCircular ? width / 2 : 8,
                    placeholderSymbol: placeholderSymbol
                )
                .frame(width: width, height: width)
                // ArtworkView already rounds its own corners; this extra pass
                // is only here to force a true circle for the artist variant
                // (radius = half the side reads as a squircle otherwise).
                .clipShape(isCircular ? AnyShape(Circle()) : AnyShape(Rectangle()))

                if showPlayOverlay {
                    Image(systemName: "play.fill")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(m3.onPrimary)
                        .frame(width: 34, height: 34)
                        .background(m3.primary.opacity(0.92), in: Circle())
                        .padding(8)
                        .shadow(color: m3.scrim.opacity(0.3), radius: 4, y: 2)
                }
            }

            HStack(alignment: .top, spacing: 4) {
                Text(title)
                    .font(.m3BodyMedium.weight(.semibold))
                    .foregroundStyle(m3.onSurface)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if isExplicit { ExplicitBadge() }
            }
            if !subtitle.isEmpty {
                Text(subtitle)
                    .font(.m3BodySmall)
                    .foregroundStyle(m3.onSurfaceVariant)
                    .lineLimit(1)
            }
        }
        .frame(width: width, alignment: .leading)
        .contentShape(Rectangle())
    }
}

// MARK: - Section header

/// Section title with an optional trailing action ("Play all") and kebab
/// menu. The `SectionHeader(title:)` call shape of the old shared component
/// still compiles — everything else defaulted.
struct SectionHeader: View {
    var title: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil
    private var menuContent: AnyView? = nil

    @Environment(\.m3) private var m3

    init(title: String, actionTitle: String? = nil, action: (() -> Void)? = nil) {
        self.title = title
        self.actionTitle = actionTitle
        self.action = action
        self.menuContent = nil
    }

    init<Menu: View>(title: String, @ViewBuilder menuItems: () -> Menu) {
        self.title = title
        self.actionTitle = nil
        self.action = nil
        self.menuContent = AnyView(menuItems())
    }

    var body: some View {
        HStack(spacing: 4) {
            Text(title)
                .font(.m3TitleLarge)
                .foregroundStyle(m3.onSurface)
                .lineLimit(1)
            Spacer(minLength: 8)
            if let action, let actionTitle {
                Button(actionTitle, action: action)
                    .buttonStyle(M3TextStyle(compact: true))
            }
            if let menuContent {
                Menu {
                    menuContent
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(width: 36, height: 36)
                }
                .labelStyle(.iconOnly)
                .foregroundStyle(m3.onSurfaceVariant)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
    }
}
