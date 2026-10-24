//
//  Components.swift
//  Carmen — the shared building blocks every screen composes from:
//  navigation routes, artwork, track rows, feed tiles and state views.
//

import SwiftUI

// MARK: - Navigation

/// Push destinations, built from feed/search cards. Songs and stations are
/// *played*, not pushed, so they never produce a route.
enum Route: Hashable {
    case album(browseId: String, title: String)
    case artist(channelId: String, title: String)
    case playlist(playlistId: String, title: String)

    init?(card: MediaCard) {
        guard !card.targetId.isEmpty else { return nil }
        switch card.kind {
        case .album: self = .album(browseId: card.targetId, title: card.title)
        case .artist: self = .artist(channelId: card.targetId, title: card.title)
        case .playlist: self = .playlist(playlistId: card.targetId, title: card.title)
        case .song, .station, .unsupported: return nil
        }
    }
}

/// The single place card taps and `NavigationLink`s resolve to screens.
/// Applied to every tab's NavigationStack via `.carmenDestinations()`.
struct CarmenDestinations: ViewModifier {
    func body(content: Content) -> some View {
        content.navigationDestination(for: Route.self) { route in
            switch route {
            case .album(let browseId, let title):
                AlbumView(browseId: browseId, title: title)
            case .artist(let channelId, let title):
                ArtistView(channelId: channelId, title: title)
            case .playlist(let playlistId, let title):
                PlaylistView(playlistId: playlistId, title: title)
            }
        }
    }
}

extension View {
    func carmenDestinations() -> some View { modifier(CarmenDestinations()) }
}

/// Playable tracks out of a mixed card row (home sections, search results).
func playableTracks(_ cards: [MediaCard]) -> [Track] {
    cards.compactMap { $0.kind == .song ? $0.track : nil }
}

// MARK: - State views

struct LoadingState: View {
    var label: String = "Loading…"

    var body: some View {
        VStack(spacing: 10) {
            ProgressView()
            Text(label).font(.subheadline).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.vertical, 60)
    }
}

struct ErrorState: View {
    let message: String
    var retry: (() -> Void)?

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 34))
                .foregroundStyle(.secondary)
            Text("Something went wrong")
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            if let retry {
                Button("Try Again", action: retry)
                    .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 50)
    }
}

struct EmptyState: View {
    let title: String
    var hint: String?

    var body: some View {
        VStack(spacing: 8) {
            Text(title).font(.headline)
            if let hint {
                Text(hint)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 50)
        .padding(.horizontal, 24)
    }
}

// MARK: - Track row

/// One row of a song list: artwork (or index), title, artist, duration and
/// the Apple Music-style context menu. Tapping plays `track` inside `context`;
/// the trailing heart favorites it without opening anything.
struct TrackRow: View {
    let track: Track
    var context: [Track] = []
    var index: Int?
    var showArtwork: Bool = true
    var showAlbumLine: Bool = false

    @Environment(Player.self) private var player
    @Environment(LibraryStore.self) private var library
    @Environment(DownloadsStore.self) private var downloads

    private var isCurrent: Bool { player.current?.videoId == track.videoId }

    var body: some View {
        HStack(spacing: 4) {
            Button {
                let startAt = context.firstIndex { $0.videoId == track.videoId } ?? 0
                player.play(context.isEmpty ? [track] : context, startAt: startAt)
            } label: {
                HStack(spacing: 12) {
                    artworkOrIndex
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 5) {
                            Text(track.title)
                                .font(.body)
                                .lineLimit(1)
                                .foregroundStyle(isCurrent ? Color.carmen : .primary)
                            if track.isExplicit { ExplicitBadge() }
                        }
                        HStack(spacing: 4) {
                            Text(subtitle)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            if downloads.isDownloaded(track.videoId) {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    Spacer(minLength: 8)
                    if isCurrent {
                        Image(systemName: "waveform")
                            .font(.footnote)
                            .foregroundStyle(Color.carmen)
                    } else {
                        Text(track.durationLabel ?? "")
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            FavoriteButton(track: track)
        }
        .contextMenu { menu }
    }

    private var subtitle: String {
        if showAlbumLine && !track.albumName.isEmpty {
            return "\(track.artistLine) — \(track.albumName)"
        }
        return track.artistLine
    }

    @ViewBuilder private var artworkOrIndex: some View {
        if showArtwork {
            ArtworkView(url: track.artwork, fallbackURL: track.artworkAlt, cornerRadius: 4)
                .frame(width: 44, height: 44)
        } else if let index {
            Text("\(index)")
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(width: 24, alignment: .trailing)
        }
    }

    @ViewBuilder private var menu: some View {
        Button {
            player.playNext(track)
        } label: {
            Label("Play Next", systemImage: "text.insert")
        }
        Button {
            player.enqueue(track)
        } label: {
            Label("Add to Queue", systemImage: "list.bullet.plus")
        }
        Button {
            library.toggleFavorite(track)
        } label: {
            Label(
                library.isFavorite(track.videoId) ? "Remove Favorite" : "Favorite",
                systemImage: library.isFavorite(track.videoId) ? "heart.slash" : "heart")
        }
        Button {
            player.playStation(seed: track)
        } label: {
            Label("Play Radio", systemImage: "dot.radiowaves.left.and.right")
        }
        Menu {
            PlaylistPickerMenu(track: track)
        } label: {
            Label("Add to Playlist…", systemImage: "music.note.list")
        }
        Divider()
        DownloadMenuItems(track: track)
        if let albumId = track.album?.id, !albumId.isEmpty {
            NavigationLink(value: Route.album(browseId: albumId, title: track.albumName)) {
                Label("Go to Album", systemImage: "square.stack")
            }
        }
        if let artistId = track.artists.first(where: { !($0.id ?? "").isEmpty })?.id {
            NavigationLink(value: Route.artist(channelId: artistId, title: track.artists[0].name)) {
                Label("Go to Artist", systemImage: "person.crop.circle")
            }
        }
        ShareLink(item: "https://carmen.z44d.com/?song=\(track.videoId)") {
            Label("Share", systemImage: "square.and.arrow.up")
        }
    }
}

// MARK: - Feed tile

/// Card used by home rows and search grids: big artwork, title, subtitle.
/// Songs play in their row context; albums/artists/playlists push a screen;
/// stations start a radio queue.
struct CardTile: View {
    let card: MediaCard
    /// Sibling cards of the same row — the play context when tapped.
    var siblings: [MediaCard] = []
    var width: CGFloat = 150

    @Environment(Player.self) private var player

    var body: some View {
        if let track = card.track, card.kind == .song {
            Button {
                var context = playableTracks(siblings)
                if context.isEmpty { context = [track] }
                let startAt = context.firstIndex { $0.videoId == track.videoId } ?? 0
                player.play(context, startAt: startAt)
            } label: {
                content
            }
            .buttonStyle(.plain)
        } else if let route = Route(card: card) {
            NavigationLink(value: route) { content }
                .buttonStyle(.plain)
        } else {
            Button {
                if card.kind == .station, !card.targetId.isEmpty {
                    player.playWatch(playlistId: card.targetId)
                }
            } label: {
                content
            }
            .buttonStyle(.plain)
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 6) {
            ArtworkView(
                url: card.artwork,
                fallbackURL: card.artworkAlt,
                cornerRadius: 8,
                placeholderSymbol: placeholderSymbol
            )
            .frame(width: width, height: width)
            HStack(spacing: 4) {
                Text(card.title)
                    .font(.footnote.weight(.semibold))
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                if card.isExplicit && card.kind == .song { ExplicitBadge() }
            }
            if !card.subtitle.isEmpty {
                Text(card.subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(width: width, alignment: .leading)
        .contentShape(Rectangle())
    }

    private var placeholderSymbol: String {
        switch card.kind {
        case .artist: return "person.crop.square"
        case .playlist, .station: return "music.note.list"
        case .album: return "square.stack"
        case .song, .unsupported: return "music.note"
        }
    }
}

// MARK: - Track tile

/// Square tile of a bare `Track` (home suggestions): artwork, title, artist.
/// `context` is the full play order the Home screen built around the tap
/// (frontend: `[tapped] + recents + shuffled suggestions`).
struct TrackTile: View {
    let track: Track
    var context: [Track]
    var width: CGFloat = 150

    @Environment(Player.self) private var player

    private var isCurrent: Bool { player.current?.videoId == track.videoId }

    var body: some View {
        Button {
            let startAt = context.firstIndex { $0.videoId == track.videoId } ?? 0
            player.play(context.isEmpty ? [track] : context, startAt: startAt)
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                ZStack(alignment: .bottomLeading) {
                    ArtworkView(url: track.artwork, fallbackURL: track.artworkAlt, cornerRadius: 8)
                        .frame(width: width, height: width)
                    if isCurrent {
                        Image(systemName: "waveform")
                            .font(.footnote)
                            .foregroundStyle(.white)
                            .padding(6)
                            .shadow(radius: 2)
                    }
                }
                HStack(spacing: 4) {
                    Text(track.title)
                        .font(.footnote.weight(.semibold))
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .foregroundStyle(isCurrent ? Color.carmen : .primary)
                    if track.isExplicit { ExplicitBadge() }
                }
                Text(track.artistLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(width: width, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button { player.playNext(track) } label: {
                Label("Play Next", systemImage: "text.insert")
            }
            Button { player.enqueue(track) } label: {
                Label("Add to Queue", systemImage: "list.bullet.plus")
            }
            Divider()
            FavoriteButton(track: track)
            DownloadMenuItems(track: track)
        }
    }
}
