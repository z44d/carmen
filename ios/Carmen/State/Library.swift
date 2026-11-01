//
//  Library.swift
//  Carmen — the on-device library.
//
//  The API is read-only: favorites, recents, local playlists and search
//  history live on the phone, persisted as one JSON document in Application
//  Support (same division of labour as the web client's SQLite tables, but
//  with no Tauri/sql plugin available here).
//

import Foundation
import Observation

struct LocalPlaylist: Codable, Hashable, Identifiable, Sendable {
    var id: UUID
    var name: String
    var createdAt: Date
    var tracks: [Track]

    init(name: String, tracks: [Track] = []) {
        self.id = UUID()
        self.name = name
        self.createdAt = Date()
        self.tracks = tracks
    }
}

@MainActor
@Observable
final class LibraryStore {
    /// Shared instance (Player records recents through it).
    static let shared = LibraryStore()

    private enum Key {
        static let favorites = "library.favorites"
        static let recents = "library.recents"
        static let playlists = "library.playlists"
        static let searchHistory = "library.searchHistory"
        static let suggestions = "library.suggestions"
        static let podcasts = "library.podcasts"
    }

    private static let maxRecents = 10
    private static let maxSuggestions = 100
    private static let maxSearchHistory = 10

    @ObservationIgnored private let defaults: UserDefaults = .standard

    private var _favorites: [Track]
    private var _recents: [Track]
    private var _playlists: [LocalPlaylist]
    private var _searchHistory: [String]
    private var _suggestions: [Track]
    private var _podcasts: [SavedPodcast]

    // MARK: Observable API (each mutation persists)

    var favorites: [Track] {
        get { _favorites }
        set {
            _favorites = newValue
            save(Key.favorites, newValue)
        }
    }

    /// Most recently played first, deduped by video id.
    var recents: [Track] {
        get { _recents }
        set {
            _recents = newValue
            save(Key.recents, newValue)
        }
    }

    var playlists: [LocalPlaylist] {
        get { _playlists }
        set {
            _playlists = newValue
            save(Key.playlists, newValue)
        }
    }

    /// Podcast shows saved from search results (Library → Podcasts).
    var podcasts: [SavedPodcast] {
        get { _podcasts }
        set {
            _podcasts = newValue
            save(Key.podcasts, newValue)
        }
    }

    func isPodcastSaved(_ playlistId: String) -> Bool {
        _podcasts.contains { $0.playlistId == playlistId }
    }

    /// Save/unsave a show; newest first, like the web client's podcast subs.
    func togglePodcast(_ podcast: SavedPodcast) {
        if isPodcastSaved(podcast.playlistId) {
            podcasts = _podcasts.filter { $0.playlistId != podcast.playlistId }
        } else {
            podcasts = [podcast] + _podcasts.filter { $0.playlistId != podcast.playlistId }
        }
    }

    var searchHistory: [String] {
        get { _searchHistory }
        set {
            _searchHistory = newValue
            save(Key.searchHistory, newValue)
        }
    }

    /// "Suggested for you" — songs harvested from the related lists of what
    /// the user plays (first 10 per play, FIFO cap 100). Backs the Home feed
    /// exactly like `library.suggestions` on the web client.
    var suggestions: [Track] {
        get { _suggestions }
        set {
            _suggestions = newValue
            save(Key.suggestions, newValue)
        }
    }

    init() {
        _favorites = Self.load([Track].self, forKey: Key.favorites) ?? []
        _recents = Self.load([Track].self, forKey: Key.recents) ?? []
        _playlists = Self.load([LocalPlaylist].self, forKey: Key.playlists) ?? []
        _searchHistory = Self.load([String].self, forKey: Key.searchHistory) ?? []
        _suggestions = Self.load([Track].self, forKey: Key.suggestions) ?? []
        _podcasts = Self.load([SavedPodcast].self, forKey: Key.podcasts) ?? []
    }

    // MARK: Favorites

    func isFavorite(_ videoId: String) -> Bool {
        _favorites.contains { $0.videoId == videoId }
    }

    func toggleFavorite(_ track: Track) {
        if isFavorite(track.videoId) {
            favorites = _favorites.filter { $0.videoId != track.videoId }
        } else {
            favorites = [track] + _favorites.filter { $0.videoId != track.videoId }
        }
    }

    // MARK: Recently played

    func recordPlay(_ track: Track) {
        var next = _recents.filter { $0.videoId != track.videoId }
        next.insert(track, at: 0)
        if next.count > Self.maxRecents { next = Array(next.prefix(Self.maxRecents)) }
        recents = next
        // A song the user actually played is no longer a *suggestion*.
        if _suggestions.contains(where: { $0.videoId == track.videoId }) {
            suggestions = _suggestions.filter { $0.videoId != track.videoId }
        }
    }

    // MARK: Suggestions (home feed)

    /// Merge freshly harvested related songs into the pool: deduped against
    /// recents + suggestions, FIFO-capped at 100 (mirrors `addSuggestions`).
    func addSuggestions(_ tracks: [Track]) {
        guard !tracks.isEmpty else { return }
        var seen = Set(_recents.map(\.videoId))
        seen.formUnion(_suggestions.map(\.videoId))
        var next = _suggestions
        for track in tracks where seen.insert(track.videoId).inserted {
            next.append(track)
        }
        guard next.count != _suggestions.count else { return }
        if next.count > Self.maxSuggestions { next = Array(next.suffix(Self.maxSuggestions)) }
        suggestions = next
    }

    /// Re-shuffle the suggestion pool (the Home refresh button).
    func reshuffleSuggestions() {
        suggestions = _suggestions.shuffled()
    }

    // MARK: Local playlists

    func createPlaylist(named name: String) -> LocalPlaylist {
        let playlist = LocalPlaylist(name: name)
        playlists = _playlists + [playlist]
        return playlist
    }

    func deletePlaylist(id: UUID) {
        playlists = _playlists.filter { $0.id != id }
    }

    func renamePlaylist(id: UUID, to name: String) {
        playlists = _playlists.map { playlist in
            guard playlist.id == id else { return playlist }
            var copy = playlist
            copy.name = name
            return copy
        }
    }

    func isSaved(inPlaylist id: UUID, videoId: String) -> Bool {
        _playlists.first { $0.id == id }?.tracks.contains { $0.videoId == videoId } ?? false
    }

    func toggleTrack(_ track: Track, inPlaylist id: UUID) {
        playlists = _playlists.map { playlist in
            guard playlist.id == id else { return playlist }
            var copy = playlist
            if copy.tracks.contains(where: { $0.videoId == track.videoId }) {
                copy.tracks.removeAll { $0.videoId == track.videoId }
            } else {
                copy.tracks.append(track)
            }
            return copy
        }
    }

    func addTracks(_ tracks: [Track], toPlaylist id: UUID) {
        playlists = _playlists.map { playlist in
            guard playlist.id == id else { return playlist }
            var copy = playlist
            let existing = Set(copy.tracks.map(\.videoId))
            copy.tracks.append(contentsOf: tracks.filter { !existing.contains($0.videoId) })
            return copy
        }
    }

    func playlist(id: UUID) -> LocalPlaylist? {
        _playlists.first { $0.id == id }
    }

    // MARK: Search history

    func recordSearch(_ query: String) {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else { return }
        var next = _searchHistory.filter { $0.caseInsensitiveCompare(trimmed) != .orderedSame }
        next.insert(trimmed, at: 0)
        if next.count > Self.maxSearchHistory { next = Array(next.prefix(Self.maxSearchHistory)) }
        searchHistory = next
    }

    func clearSearchHistory() {
        searchHistory = []
    }

    // MARK: Persistence

    private func save<T: Encodable>(_ key: String, _ value: T) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        defaults.set(data, forKey: key)
    }

    private static func load<T: Decodable>(_ type: T.Type, forKey key: String) -> T? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}
