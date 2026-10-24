//
//  HomeView.swift
//  Carmen — the Home tab in Material 3 dress (Android HomeScreen parity).
//
//  Two local sections come first — the 10 most recently played songs plus up
//  to 100 suggestions harvested from the related lists of everything the
//  user plays — followed by the curated YouTube Music rows the Carmen
//  server offers via /browsing/home. Remote rows are a bonus: if the
//  server is unreachable they are simply omitted and the personal feed
//  stays on screen.
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

    private let columns = [
        GridItem(.flexible(), spacing: 16),
        GridItem(.flexible(), spacing: 16),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                keepListening
                suggestions
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

    /// Subtle tonal wash behind the feed — the seed's primary container
    /// fading into the background, like Android's home surface.
    private var backdrop: some View {
        LinearGradient(
            colors: [m3.primaryContainer.opacity(0.35), m3.background],
            startPoint: .top,
            endPoint: .bottom
        )
        .ignoresSafeArea()
    }

    // MARK: Keep listening

    @ViewBuilder private var keepListening: some View {
        if !recentSnapshot.isEmpty {
            SectionHeader(title: "Keep listening")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 16) {
                    ForEach(recentSnapshot) { track in
                        GridTile(track: track, context: recentSnapshot)
                    }
                }
                .padding(.horizontal, 16)
            }
        }
    }

    // MARK: Carmen suggestions

    @ViewBuilder private var suggestions: some View {
        if !suggestionSnapshot.isEmpty {
            SectionHeader(title: "Carmen suggestions", menuItems: {
                Button("Reshuffle") {
                    library.reshuffleSuggestions()
                    snapshot()
                }
            })
            LazyVGrid(columns: columns, spacing: 20) {
                ForEach(
                    Array(suggestionSnapshot.prefix(visibleSuggestions).enumerated()),
                    id: \.offset
                ) { index, track in
                    GridTile(track: track, context: suggestionContext(for: track))
                        .onAppear {
                            // Prefetch the next page before the user hits it.
                            if index >= visibleSuggestions - 6 { visibleSuggestions += 12 }
                        }
                }
            }
            .padding(.horizontal, 16)
        }
    }

    // MARK: Remote home sections

    @ViewBuilder private var remote: some View {
        if remoteLoading, remoteSections.isEmpty {
            // First load: skeleton shaped like the grid above while the
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
                HStack(alignment: .top, spacing: 16) {
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
}
