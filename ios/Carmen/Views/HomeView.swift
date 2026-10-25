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
                keepListening
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
            .overlay(m3.outlineVariant.opacity(0.9), in: M3Shape.dialog.strokeBorder(lineWidth: 1))
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
}
