//
//  SearchView.swift
//  Carmen — the Search tab: debounced search against the backend, results
//  grouped by the API's `category` labels, plus the local search history.
//

import SwiftUI

/// One visual group of the flat search payload — the `category` label of its
/// cards, `nil` for unlabelled cards (rendered last, without a header).
private struct SearchGroup: Identifiable {
    let title: String?
    let cards: [MediaCard]

    var id: String { title ?? "" }
}

struct SearchView: View {
    @Environment(SettingsStore.self) private var settings
    @Environment(LibraryStore.self) private var library
    @Environment(Player.self) private var player

    @State private var query = ""
    @State private var results: [MediaCard]?
    @State private var suggestions: [String] = []
    @State private var errorMessage: String?
    @State private var isSearching = false
    /// Type filter, frontend parity: same chips, same default (Songs), and
    /// it survives leaving the tab like the web client's `?filter=`.
    @AppStorage("carmen.search.filter") private var filter = "songs"

    /// The frontend's chip row — `All` is the empty id the backend treats
    /// as "no filter".
    private static let filters: [(id: String, label: String)] = [
        ("all", "All"),
        ("songs", "Songs"),
        ("videos", "Videos"),
        ("albums", "Albums"),
        ("artists", "Artists"),
        ("playlists", "Playlists"),
    ]

    private var trimmed: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 24) {
                if trimmed.isEmpty {
                    historySection
                } else if let errorMessage {
                    ErrorState(message: errorMessage) {
                        Task { await retrySearch() }
                    }
                } else if let results {
                    if results.isEmpty {
                        EmptyState(
                            title: "No Results",
                            hint: filter == "all"
                                ? "Try a different search."
                                : "Check the spelling or try another filter."
                        )
                    } else {
                        resultsContent(results)
                    }
                } else {
                    LoadingState(label: "Searching…")
                }
            }
            .padding(.vertical, 8)
        }
        .navigationTitle("Search")
        .navigationBarTitleDisplayMode(.large)
        .searchable(
            text: $query,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Songs, artists, albums…"
        )
        .task(id: "\(trimmed)#\(filter)") {
            await runSearch()
        }
    }

    // MARK: Type filter (chips)

    private var filterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Self.filters, id: \.id) { option in
                    Button {
                        filter = option.id
                    } label: {
                        Text(option.label)
                            .font(.subheadline.weight(.medium))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 7)
                            .background(Capsule().fill(chipFill(option.id)))
                            .foregroundStyle(chipInk(option.id))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal)
        }
    }

    private func chipFill(_ id: String) -> Color {
        filter == id ? Color.carmen : Color(.secondarySystemBackground)
    }

    private func chipInk(_ id: String) -> Color {
        filter == id ? Color.carmenOnAccent : Color.secondary
    }

    // MARK: Search history (empty query)

    @ViewBuilder private var historySection: some View {
        if library.searchHistory.isEmpty {
            EmptyState(title: "Search Carmen", hint: "Find songs, artists, albums and playlists.")
        } else {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("Search History")
                        .font(.title3.weight(.bold))
                    Spacer()
                    Button {
                        library.clearSearchHistory()
                    } label: {
                        Image(systemName: "trash")
                            .font(.subheadline)
                            .foregroundStyle(Color.carmen)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal)

                ForEach(library.searchHistory, id: \.self) { term in
                    Button {
                        query = term
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "magnifyingglass")
                                .foregroundStyle(.secondary)
                            Text(term)
                                .font(.body)
                                .lineLimit(1)
                            Spacer(minLength: 8)
                        }
                        .padding(.horizontal)
                        .padding(.vertical, 2)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: Results

    @ViewBuilder private func resultsContent(_ cards: [MediaCard]) -> some View {
        if isSearching {
            ProgressView()
                .frame(maxWidth: .infinity)
        }
        filterBar
        if !suggestions.isEmpty {
            suggestionSection
        }
        ForEach(groups(cards)) { group in
            groupView(group)
        }
    }

    private var suggestionSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            SectionHeader(title: "Suggested")
            ForEach(suggestions, id: \.self) { term in
                Button {
                    query = term
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "magnifyingglass")
                            .foregroundStyle(.secondary)
                        Text(term)
                            .font(.body)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 2)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// Flat payload → groups by `category`, preserving first-appearance order;
    /// unlabelled cards form one trailing group without a header.
    private func groups(_ cards: [MediaCard]) -> [SearchGroup] {
        var order: [String] = []
        var buckets: [String: [MediaCard]] = [:]
        var untitled: [MediaCard] = []
        for card in cards {
            guard let category = card.category, !category.isEmpty else {
                untitled.append(card)
                continue
            }
            if buckets[category] == nil {
                buckets[category] = []
                order.append(category)
            }
            buckets[category]?.append(card)
        }
        var grouped = order.map { SearchGroup(title: $0, cards: buckets[$0] ?? []) }
        if !untitled.isEmpty {
            grouped.append(SearchGroup(title: nil, cards: untitled))
        }
        return grouped
    }

    @ViewBuilder private func groupView(_ group: SearchGroup) -> some View {
        if let title = group.title {
            switch title.lowercased() {
            case "top result":
                VStack(alignment: .leading, spacing: 12) {
                    SectionHeader(title: title)
                    if let card = group.cards.first {
                        TopResultCard(card: card, context: playableTracks(results ?? []))
                    }
                }
            case "songs":
                VStack(alignment: .leading, spacing: 4) {
                    SectionHeader(title: title)
                    ForEach(group.cards) { card in
                        if let track = card.track {
                            TrackRow(track: track, context: playableTracks(group.cards))
                        }
                    }
                }
            default:
                cardList(group.cards)
            }
        } else {
            cardList(group.cards)
        }
    }

    private func cardList(_ cards: [MediaCard]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(cards) { card in
                SearchCardRow(card: card, context: playableTracks(cards))
            }
        }
    }

    // MARK: Loading

    private func runSearch() async {
        guard !trimmed.isEmpty else {
            results = nil
            suggestions = []
            errorMessage = nil
            isSearching = false
            return
        }
        isSearching = true
        errorMessage = nil
        // Debounce — this task restarts on every keystroke via `task(id:)`.
        try? await Task.sleep(for: .milliseconds(350))
        if Task.isCancelled { return }
        await fetch(trimmed)
    }

    private func retrySearch() async {
        guard !trimmed.isEmpty else { return }
        isSearching = true
        errorMessage = nil
        await fetch(trimmed)
    }

    private func fetch(_ term: String) async {
        let api = API(baseURL: settings.apiBaseURL)
        let activeFilter = filter
        do {
            let found = try await api.search(term, filter: activeFilter, limit: 100)
            if Task.isCancelled { return }
            results = found
            isSearching = false
            if !found.isEmpty {
                library.recordSearch(term)
            }
        } catch is CancellationError {
            return
        } catch {
            if Task.isCancelled { return }
            results = nil
            errorMessage = error.localizedDescription
            isSearching = false
            return
        }
        // Best effort — a suggestions failure must never surface as an error.
        if let hints = try? await api.suggestions(term), !Task.isCancelled {
            suggestions = hints
        }
    }
}

// MARK: - Result rows

/// The "Top result" card — one prominent horizontal card (large artwork).
/// Taps mirror `CardTile`: songs play in their result context, everything
/// navigable pushes its screen, stations start a radio queue.
private struct TopResultCard: View {
    let card: MediaCard
    var context: [Track] = []

    @Environment(Player.self) private var player

    var body: some View {
        if card.kind == .song, let track = card.track {
            Button {
                var queue = context
                if queue.isEmpty { queue = [track] }
                let startAt = queue.firstIndex { $0.videoId == track.videoId } ?? 0
                player.play(queue, startAt: startAt)
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
        HStack(spacing: 14) {
            ArtworkView(
                url: card.artwork,
                fallbackURL: card.artworkAlt,
                cornerRadius: 8,
                placeholderSymbol: placeholderSymbol
            )
            .frame(width: 120, height: 120)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 5) {
                    Text(card.title)
                        .font(.title2.bold())
                        .lineLimit(2)
                    if card.isExplicit && card.kind == .song {
                        ExplicitBadge()
                    }
                }
                if !card.subtitle.isEmpty {
                    Text(card.subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal)
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

/// One vertical result row (Apple Music shows lists, not grids): 56pt
/// artwork, title, subtitle. Tap behaviour matches `CardTile`.
private struct SearchCardRow: View {
    let card: MediaCard
    var context: [Track] = []

    @Environment(Player.self) private var player

    var body: some View {
        if card.kind == .song, let track = card.track {
            Button {
                var queue = context
                if queue.isEmpty { queue = [track] }
                let startAt = queue.firstIndex { $0.videoId == track.videoId } ?? 0
                player.play(queue, startAt: startAt)
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
        HStack(spacing: 12) {
            ArtworkView(
                url: card.artwork,
                fallbackURL: card.artworkAlt,
                cornerRadius: 6,
                placeholderSymbol: placeholderSymbol
            )
            .frame(width: 56, height: 56)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    Text(card.title)
                        .font(.body)
                        .lineLimit(1)
                    if card.isExplicit && card.kind == .song {
                        ExplicitBadge()
                    }
                }
                if !card.subtitle.isEmpty {
                    Text(card.subtitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
        }
        .padding(.horizontal)
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
