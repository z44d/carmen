//
//  Navigation.swift
//  Carmen — the navigation contract: routes, their destinations, and the
//  card→track helper every feed row plays through.
//
//  Moved verbatim from the old shared Components.swift, plus the search
//  results route the Material search screen pushes.
//

import SwiftUI

/// Push destinations, built from feed/search cards. Songs and stations are
/// *played*, not pushed, so they never produce a route.
enum Route: Hashable {
    case album(browseId: String, title: String)
    case artist(channelId: String, title: String)
    case playlist(playlistId: String, title: String)
    /// A podcast show — Android's `podcast/{browseId}` route.
    case podcast(playlistId: String, title: String)
    /// A submitted search query — Android's `search_results/{query}` route.
    case searchResults(query: String)

    init?(card: MediaCard) {
        guard !card.targetId.isEmpty else { return nil }
        switch card.kind {
        case .album: self = .album(browseId: card.targetId, title: card.title)
        case .artist: self = .artist(channelId: card.targetId, title: card.title)
        case .playlist: self = .playlist(playlistId: card.targetId, title: card.title)
        case .podcast: self = .podcast(playlistId: card.targetId, title: card.title)
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
            case .podcast(let playlistId, let title):
                PodcastView(playlistId: playlistId, title: title)
            case .searchResults(let query):
                SearchResultsView(query: query)
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
