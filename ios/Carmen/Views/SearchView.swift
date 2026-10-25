//
//  SearchView.swift
//  Carmen — the Search tab in Material 3 dress (Android search parity).
//
//  Two screens live here: `SearchView` is the tab (a fake search dock that
//  pushes, plus the local recent-search history), `SearchResultsView` is the
//  pushed route with the editable field, the Online/Local source switch, the
//  type-filter chip row and the grouped results. The request/decode logic is
//  the same /search + /search/suggestions contract the old screen used.
//

import SwiftUI

// MARK: - Types

/// One visual group of the flat search payload — the `category` label of its
/// cards, `nil` for unlabelled cards (rendered last, without a header).
private struct SearchGroup: Identifiable {
    let title: String?
    let cards: [MediaCard]

    var id: String { title ?? "" }
}

/// The source segmented control: server search vs the on-device library.
private enum SearchSource: Hashable {
    case online, local
}

/// One type-filter chip: the backend's `filter` id and its label. A struct
/// rather than a labelled tuple — key paths can't refer to tuple elements,
/// so `ForEach` keys off `Identifiable` here.
private struct SearchFilter: Identifiable {
    let id: String
    let label: String
}

/// Client-side result order (the sort menu next to the filter chips).
private enum ResultSort: Equatable {
    case relevance, title, duration

    var title: String {
        switch self {
        case .relevance: return "Relevance"
        case .title: return "Title"
        case .duration: return "Duration"
        }
    }
}

// MARK: - Search tab

struct SearchView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(\.m3) private var m3

    @State private var showSettings = false

    /// The store already caps history at 10; the prefix keeps the promise.
    private var history: [String] {
        Array(library.searchHistory.prefix(10))
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                searchDock
                if history.isEmpty {
                    M3EmptyState(
                        title: "Search Carmen",
                        hint: "Find songs, artists, albums and playlists.",
                        systemImage: "magnifyingglass"
                    )
                } else {
                    historySection
                }
            }
            .padding(.top, 8)
            .padding(.bottom, 24)
        }
        .background { m3.background.ignoresSafeArea() }
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top) {
            TopAppBar(title: "Search", onOverflow: { showSettings = true })
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
    }

    // MARK: Search dock

    /// `M3SearchDock`'s visuals as a `NavigationLink` — a Button can't nest
    /// inside a NavigationLink, so the label is inlined here.
    private var searchDock: some View {
        NavigationLink(value: Route.searchResults(query: "")) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(m3.onSurfaceVariant)
                Text("Search songs, albums, artists…")
                    .font(.m3BodyLarge)
                    .foregroundStyle(m3.onSurfaceVariant)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .frame(height: 52)
            .background(m3.surfaceContainerHigh, in: M3Shape.pill)
        }
        .buttonStyle(.plain)
        .pressScale(0.99)
        .padding(.horizontal, 16)
    }

    // MARK: Recent searches

    private var historySection: some View {
        VStack(alignment: .leading, spacing: 0) {
            // LibraryStore has no per-entry removal — offer "Clear history".
            SectionHeader(title: "Recent searches", actionTitle: "Clear history") {
                library.clearSearchHistory()
            }
            ForEach(history, id: \.self) { term in
                NavigationLink(value: Route.searchResults(query: term)) {
                    historyRow(term)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func historyRow(_ term: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: "clock")
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(m3.onSurfaceVariant)
                .frame(width: 40, height: 40)
                .background(m3.surfaceContainerHighest, in: M3Shape.small)
            Text(term)
                .font(.m3BodyLarge)
                .foregroundStyle(m3.onSurface)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
            Spacer(minLength: 8)
            Image(systemName: "arrow.up.left")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(m3.onSurfaceVariant)
        }
        .padding(.horizontal, 16)
        .frame(height: 64)
        .contentShape(Rectangle())
    }
}

// MARK: - Search results

struct SearchResultsView: View {
    @Environment(\.m3) private var m3
    @Environment(LibraryStore.self) private var library
    @Environment(Player.self) private var player
    @Environment(SettingsStore.self) private var settings

    @State private var query: String
    /// The query that has actually been run — every submit and every tapped
    /// history/suggestion term re-keys `.task(id:)` from here.
    @State private var submitted: String
    @State private var source: SearchSource = .online
    @State private var results: [MediaCard]?
    @State private var suggestions: [String] = []
    @State private var errorMessage: String?
    @State private var isLoading = false
    @State private var sort: ResultSort = .relevance
    /// Type filter, frontend parity: same chips, same default (Songs), and
    /// it survives leaving the screen like the web client's `?filter=`.
    @AppStorage("carmen.search.filter") private var filter = "songs"

    init(query: String) {
        _query = State(initialValue: query)
        _submitted = State(initialValue: query.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// The frontend's chip row — `all` is the id the backend treats as "no
    /// filter"; everything else maps 1:1 onto the server's `filter` values
    /// (server/core.py: songs, videos, albums, artists, playlists,
    /// community_playlists, featured_playlists, podcasts, …).
    private static let filters: [SearchFilter] = [
        SearchFilter(id: "all", label: "All"),
        SearchFilter(id: "songs", label: "Songs"),
        SearchFilter(id: "videos", label: "Videos"),
        SearchFilter(id: "albums", label: "Albums"),
        SearchFilter(id: "artists", label: "Artists"),
        SearchFilter(id: "playlists", label: "Playlists"),
        SearchFilter(id: "podcasts", label: "Podcasts"),
        SearchFilter(id: "community_playlists", label: "Community"),
        SearchFilter(id: "featured_playlists", label: "Featured Playlists"),
    ]

    private var trimmed: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Re-runs the query on submit, filter change and source change (local
    /// needs no network — the guard below short-circuits it).
    private var searchKey: String {
        "\(submitted)#\(filter)#\(source == .online)"
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                content
            }
            .padding(.vertical, 12)
        }
        .background { m3.background.ignoresSafeArea() }
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .top) { header }
        .task(id: searchKey) {
            await runSearch()
        }
        .onChange(of: query) { _, value in
            // Clearing the field (the ✕) drops straight back to the empty state.
            if value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !submitted.isEmpty {
                submitted = ""
            }
        }
    }

    // MARK: Pinned header (field + source + filters)

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            M3SearchField(
                text: $query,
                placeholder: "Songs, artists, albums…",
                autoFocus: query.isEmpty,
                onSubmit: submit
            )
            .padding(.horizontal, 16)

            Picker("Source", selection: $source) {
                Text("Online").tag(SearchSource.online)
                Text("Local").tag(SearchSource.local)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)

            if source == .online {
                filterRow
            }
        }
        .padding(.top, 8)
        .padding(.bottom, 10)
        .background(m3.background)
    }

    private var filterRow: some View {
        HStack(spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Self.filters) { option in
                        FilterChip(isSelected: filter == option.id, title: option.label) {
                            filter = option.id
                        }
                    }
                }
                .padding(.horizontal, 16)
            }
            // Sorting only makes sense over the unfiltered (server-ordered) mix.
            if filter == "all" {
                sortMenu.padding(.trailing, 16)
            }
        }
    }

    private var sortMenu: some View {
        Menu {
            sortOption(.relevance)
            sortOption(.title)
            sortOption(.duration)
        } label: {
            TagChip(title: sort.title, systemImage: "arrow.up.arrow.down")
        }
    }

    @ViewBuilder private func sortOption(_ option: ResultSort) -> some View {
        Button {
            sort = option
        } label: {
            if sort == option {
                Label(option.title, systemImage: "checkmark")
            } else {
                Text(option.title)
            }
        }
    }

    // MARK: Body states

    @ViewBuilder private var content: some View {
        // Local matches the live field (instant, no round-trip); online is
        // submit-driven — mid-typing keeps the previous state on screen.
        if source == .local {
            if trimmed.isEmpty {
                emptyQueryPane
            } else {
                localContent
            }
        } else if submitted.isEmpty {
            emptyQueryPane
        } else if let errorMessage {
            M3ErrorState(message: errorMessage) {
                Task { await retrySearch() }
            }
        } else if isLoading || results == nil {
            ShimmerList(rows: 8)
        } else if let results {
            if results.isEmpty {
                M3EmptyState(
                    title: "No Results",
                    hint: filter == "all"
                        ? "Try a different search."
                        : "Check the spelling or try another filter.",
                    systemImage: "magnifyingglass"
                )
            } else {
                onlineContent(results)
            }
        }
    }

    // MARK: Empty query — history + suggestions

    @ViewBuilder private var emptyQueryPane: some View {
        if !library.searchHistory.isEmpty {
            SectionHeader(title: "Recent searches", actionTitle: "Clear history") {
                library.clearSearchHistory()
            }
            ForEach(Array(library.searchHistory.prefix(10)), id: \.self) { term in
                termRow(term, systemImage: "clock") {
                    run(term)
                }
            }
        }
        if !suggestions.isEmpty {
            SectionHeader(title: "Suggested")
            ForEach(suggestions, id: \.self) { term in
                termRow(term, systemImage: "magnifyingglass") {
                    run(term)
                }
            }
        }
        if library.searchHistory.isEmpty, suggestions.isEmpty {
            M3EmptyState(
                title: "Search Carmen",
                hint: "Find songs, artists, albums and playlists.",
                systemImage: "magnifyingglass"
            )
        }
    }

    private func termRow(_ term: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 14) {
                Image(systemName: systemImage)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(m3.onSurfaceVariant)
                    .frame(width: 40, height: 40)
                    .background(m3.surfaceContainerHighest, in: M3Shape.small)
                Text(term)
                    .font(.m3BodyLarge)
                    .foregroundStyle(m3.onSurface)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                Spacer(minLength: 8)
                Image(systemName: "arrow.up.left")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(m3.onSurfaceVariant)
            }
            .padding(.horizontal, 16)
            .frame(height: 64)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Local (on-device) results

    @ViewBuilder private var localContent: some View {
        if localResults.isEmpty {
            M3EmptyState(
                title: "No Results",
                hint: "Nothing in your favorites, recents or playlists matches “\(trimmed)”.",
                systemImage: "magnifyingglass"
            )
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(localResults) { track in
                    ListRow(
                        track: track,
                        isPlaying: player.current?.videoId == track.videoId,
                        onTap: { play(localResults, tapping: track) }
                    )
                }
            }
        }
    }

    /// Case- and accent-insensitive `contains` over favorites, recents and
    /// local playlist tracks, deduped by video id (recents first).
    private var localResults: [Track] {
        let needle = normalize(trimmed)
        guard !needle.isEmpty else { return [] }
        var seen = Set<String>()
        let pool = (library.favorites + library.recents + library.playlists.flatMap(\.tracks))
            .filter { seen.insert($0.videoId).inserted }
        return pool.filter { track in
            normalize("\(track.title) \(track.artistLine) \(track.albumName)").contains(needle)
        }
    }

    private func normalize(_ text: String) -> String {
        text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
    }

    // MARK: Online results

    @ViewBuilder private func onlineContent(_ cards: [MediaCard]) -> some View {
        if filter == "all" {
            ForEach(groups(cards)) { group in
                groupSection(group, allCards: cards)
            }
        } else {
            flatSection(sorted(cards), allCards: cards)
        }
    }

    /// One `category` group: "Top result" gets its prominent card, everything
    /// else gets a section header ("Play all" when it carries songs) and rows.
    @ViewBuilder private func groupSection(_ group: SearchGroup, allCards: [MediaCard]) -> some View {
        let cards = sorted(group.cards)
        if let title = group.title, title.lowercased() == "top result" {
            VStack(alignment: .leading, spacing: 4) {
                SectionHeader(title: title)
                if let card = cards.first {
                    TopResultCard(card: card, context: playableTracks(allCards))
                }
            }
        } else if let title = group.title {
            let playable = playableTracks(cards)
            let playAll: (() -> Void)? = playable.isEmpty ? nil : { player.play(playable) }
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(
                    title: title,
                    actionTitle: playAll == nil ? nil : "Play all",
                    action: playAll
                )
                cardBlock(cards, context: cards)
            }
        } else {
            cardBlock(cards, context: cards)
        }
    }

    /// Single-filter mode: one flat run of rows — songs/videos as `ListRow`,
    /// anything without a track as a grid (an album/artist/playlist card
    /// cannot be a list row: it carries no `Track`).
    @ViewBuilder private func flatSection(_ cards: [MediaCard], allCards: [MediaCard]) -> some View {
        let withTracks = cards.filter { $0.track != nil }
        let withoutTracks = cards.filter { $0.track == nil }
        if !withTracks.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(withTracks) { card in
                    if let track = card.track {
                        ListRow(
                            track: track,
                            isPlaying: player.current?.videoId == track.videoId,
                            onTap: { play(playableTracks(allCards), tapping: track) }
                        )
                    }
                }
            }
        }
        if !withoutTracks.isEmpty {
            cardGrid(withoutTracks, context: allCards)
        }
    }

    /// Mixed cards: songs play as list rows, the rest as GridTile rows.
    @ViewBuilder private func cardBlock(_ cards: [MediaCard], context: [MediaCard]) -> some View {
        let withTracks = cards.filter { $0.track != nil }
        let withoutTracks = cards.filter { $0.track == nil }
        if !withTracks.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(withTracks) { card in
                    if let track = card.track {
                        ListRow(
                            track: track,
                            isPlaying: player.current?.videoId == track.videoId,
                            onTap: { play(playableTracks(context), tapping: track) }
                        )
                    }
                }
            }
        }
        if !withoutTracks.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 16) {
                    ForEach(withoutTracks) { card in
                        GridTile(card: card, siblings: context)
                    }
                }
                .padding(.horizontal, 16)
            }
        }
    }

    /// Two-column grid of GridTiles — used for a whole filtered result set.
    private func cardGrid(_ cards: [MediaCard], context: [MediaCard]) -> some View {
        LazyVGrid(
            columns: [
                GridItem(.flexible(), spacing: 16),
                GridItem(.flexible(), spacing: 16),
            ],
            spacing: 20
        ) {
            ForEach(cards) { card in
                GridTile(card: card, siblings: context)
            }
        }
        .padding(.horizontal, 16)
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

    /// Client-side order: Relevance keeps the server's, Title is A→Z,
    /// Duration is shortest-first (tracks without a duration sort last).
    private func sorted(_ cards: [MediaCard]) -> [MediaCard] {
        switch sort {
        case .relevance:
            return cards
        case .title:
            return cards.sorted {
                $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
            }
        case .duration:
            return cards.sorted {
                ($0.track?.durationSeconds ?? Int.max) < ($1.track?.durationSeconds ?? Int.max)
            }
        }
    }

    // MARK: Playing

    private func play(_ context: [Track], tapping track: Track) {
        var queue = context
        if queue.isEmpty { queue = [track] }
        let startAt = queue.firstIndex { $0.videoId == track.videoId } ?? 0
        player.play(queue, startAt: startAt)
    }

    // MARK: Search lifecycle

    /// Enter in the field (or a tapped term) runs immediately.
    private func submit() {
        run(query)
    }

    /// Submitting a query re-queries and records it in the local history.
    private func run(_ term: String) {
        let clean = term.trimmingCharacters(in: .whitespacesAndNewlines)
        query = clean
        submitted = clean
        if !clean.isEmpty {
            library.recordSearch(clean)
        }
    }

    private func runSearch() async {
        guard source == .online else {
            isLoading = false
            results = nil
            errorMessage = nil
            return
        }
        guard !submitted.isEmpty else {
            isLoading = false
            results = nil
            errorMessage = nil
            // Best-effort suggested terms for the empty state (the old file
            // called the same endpoint — a failure just means no section).
            if suggestions.isEmpty {
                let api = API(baseURL: settings.apiBaseURL)
                if let hints = try? await api.suggestions(""), !Task.isCancelled {
                    suggestions = hints
                }
            }
            return
        }
        isLoading = true
        errorMessage = nil
        await fetch(submitted)
    }

    private func retrySearch() async {
        guard !submitted.isEmpty else { return }
        isLoading = true
        errorMessage = nil
        await fetch(submitted)
    }

    private func fetch(_ term: String) async {
        let api = API(baseURL: settings.apiBaseURL)
        let activeFilter = filter
        do {
            let found = try await api.search(term, filter: activeFilter, limit: 100)
            if Task.isCancelled { return }
            results = found
            isLoading = false
        } catch is CancellationError {
            return
        } catch {
            if Task.isCancelled { return }
            results = nil
            errorMessage = error.localizedDescription
            isLoading = false
            return
        }
        // Best effort — a suggestions failure must never surface as an error.
        if let hints = try? await api.suggestions(term), !Task.isCancelled {
            suggestions = hints
        }
    }
}

// MARK: - Top result card

/// The "Top result" — one prominent card (large artwork). Taps mirror the old
/// `CardTile`: songs play in their result context, everything navigable
/// pushes its screen, stations start a radio queue.
private struct TopResultCard: View {
    let card: MediaCard
    var context: [Track] = []

    @Environment(Player.self) private var player
    @Environment(\.m3) private var m3

    var body: some View {
        if card.kind == .song, let track = card.track {
            M3Card(padding: 12, action: { play(track) }) {
                content
            }
        } else if let route = Route(card: card) {
            NavigationLink(value: route) {
                M3Card(padding: 12) { content }
            }
            .buttonStyle(.plain)
        } else {
            M3Card(padding: 12, action: stationTapped) {
                content
            }
        }
    }

    private func play(_ track: Track) {
        var queue = context
        if queue.isEmpty { queue = [track] }
        let startAt = queue.firstIndex { $0.videoId == track.videoId } ?? 0
        player.play(queue, startAt: startAt)
    }

    /// Non-navigable, non-song card: only stations start a radio queue.
    private func stationTapped() {
        if card.kind == .station, !card.targetId.isEmpty {
            player.playWatch(playlistId: card.targetId)
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
            .frame(width: 104, height: 104)
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 5) {
                    Text(card.title)
                        .font(.m3TitleLarge)
                        .lineLimit(2)
                        .minimumScaleFactor(0.85)
                    if card.isExplicit && card.kind == .song {
                        ExplicitBadge()
                    }
                }
                if !card.subtitle.isEmpty {
                    Text(card.subtitle)
                        .font(.m3BodyMedium)
                        .foregroundStyle(m3.onSurfaceVariant)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(M3Shape.card)
    }

    private var placeholderSymbol: String {
        switch card.kind {
        case .artist: return "person.crop.square"
        case .playlist, .station: return "music.note.list"
        case .album: return "square.stack"
        case .podcast: return "mic"
        case .song, .unsupported: return "music.note"
        }
    }
}
