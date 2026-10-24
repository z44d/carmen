//
//  RootView.swift
//  Carmen — the Material 3 shell: three tabs (Home / Search / Library)
//  behind a floating pill nav, with the mini player stacked on top of the
//  pill as one merged blob (Android's CONNECTED navigation bar) and the
//  full player as an overlay driven by Player.expansion (0 = parked below
//  the screen, 1 = full).
//
//  The native tab bar is hidden; screens pin their own TopAppBar and the
//  blob is a bottom safeAreaInset, so every tab's scroll content ends
//  above the bar instead of sliding under it. Settings is not a tab — it
//  is the overflow sheet each root screen owns.
//

import SwiftUI

struct RootView: View {
    @Environment(Player.self) private var player

    @State private var selectedTab: Tab = .home

    enum Tab: Hashable {
        case home, search, library

        var title: String {
            switch self {
            case .home: "Home"
            case .search: "Search"
            case .library: "Library"
            }
        }

        var symbol: String {
            switch self {
            case .home: "house"
            case .search: "magnifyingglass"
            case .library: "square.stack"
            }
        }

        var activeSymbol: String {
            switch self {
            case .home: "house.fill"
            case .search: "magnifyingglass"
            case .library: "square.stack.fill"
            }
        }
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            TabView(selection: $selectedTab) {
                NavigationStack {
                    HomeView()
                        .carmenDestinations()
                }
                .toolbar(.hidden, for: .tabBar)
                .tag(Tab.home)

                NavigationStack {
                    SearchView()
                        .carmenDestinations()
                }
                .toolbar(.hidden, for: .tabBar)
                .tag(Tab.search)

                NavigationStack {
                    LibraryView()
                        .carmenDestinations()
                }
                .toolbar(.hidden, for: .tabBar)
                .tag(Tab.library)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                FloatingNavBlob(selectedTab: $selectedTab)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 6)
                    // Cross-fades out as the full player expands over it
                    // (old mini-player math, now on the whole blob).
                    .opacity(player.showNowPlaying ? max(0, 1 - player.expansion * 2) : 1)
                    .scaleEffect(player.showNowPlaying ? max(0.92, 1 - player.expansion * 0.08) : 1)
            }

            // Full player: slides up from the mini bar's position — mounted
            // at expansion 0, then animated to 1 (openPlayer), and
            // drag-tracked back down inside NowPlayingView. Fixed travel
            // (taller than any iPhone) so the view is fully parked
            // off-screen at expansion 0.
            if player.showNowPlaying {
                NowPlayingView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .offset(y: (1 - player.expansion) * 1000)
                    .opacity(min(1, player.expansion * 2.5))
                    .zIndex(3)
            }
        }
        // Chosen accent (Settings → Appearance). Applied here rather than in
        // the App scene so the @Observable read re-renders every surface live.
        // A near-white accent flips system controls to black ink so switches
        // don't vanish on the app's light surfaces.
        .tint(Color.carmenControlTint)
        .animation(.snappy(duration: 0.25), value: player.hasQueue)
        // Stream failure banner — sits above everything while the player is
        // stuck; Retry re-attempts, ✕ just dismisses it.
        .overlay(alignment: .top) {
            if let message = player.errorMessage {
                ErrorBanner(message: message, retry: { player.retry() }, dismiss: { player.dismissError() })
                    .padding(.horizontal, 12)
                    .padding(.top, 4)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.snappy(duration: 0.2), value: player.errorMessage)
        .task {
            // Re-attach the Live Activities (lyrics + downloads) if any
            // outlived the app.
            LyricActivityController.shared.adoptExisting()
            DownloadActivityController.shared.adoptExisting()
        }
        .onChange(of: NetworkMonitor.shared.isOnline) { _, online in
            // A stream that died offline quietly restarts on reconnect
            // (covers the offline-play → reconnect repro).
            if online { player.retryIfBroken() }
        }
        // Material scheme for the whole shell — keep this the OUTERMOST
        // modifier so the floating bar, the banner overlay and every screen
        // below receive the live roles.
        .m3Theme()
    }
}

/// The floating bottom bar: the nav pill with the mini player stacked on
/// top when something is queued — Android's CONNECTED navigation bar. One
/// blob in `surfaceContainer`; radii lerp 32 (standalone) → 28 (merged)
/// with mini-player proximity, exactly like the Compose original.
private struct FloatingNavBlob: View {
    @Binding var selectedTab: RootView.Tab

    @Environment(Player.self) private var player
    @Environment(\.m3) private var m3

    /// 0 = pill alone, 1 = mini player seated on it (miniPlayerProximity).
    private var proximity: CGFloat { player.hasQueue ? 1 : 0 }

    /// Android's FloatingBarStandaloneCornerRadius (32) → …Outer (28).
    private var outerRadius: CGFloat { 32 - 4 * proximity }

    var body: some View {
        VStack(spacing: 0) {
            if player.hasQueue {
                MiniPlayer()
                    .transition(.opacity)
            }
            pill
        }
        .frame(maxWidth: 420)  // NavigationBarMaxWidth
        .background(
            m3.surfaceContainer,
            in: RoundedRectangle(cornerRadius: outerRadius, style: .continuous)
        )
        .clipShape(RoundedRectangle(cornerRadius: outerRadius, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
    }

    private var pill: some View {
        HStack(spacing: 0) {
            ForEach([RootView.Tab.home, .search, .library], id: \.self) { tab in
                pillItem(tab)
            }
        }
        .frame(maxWidth: 360)  // NavigationItemsMaxWidth
        .padding(.vertical, 8)  // NavigationItemVerticalPadding
        .frame(maxWidth: .infinity)
        .frame(height: M3Dim.navPill)  // NavigationBarHeight = 78
    }

    private func pillItem(_ tab: RootView.Tab) -> some View {
        let selected = selectedTab == tab
        return Button {
            selectedTab = tab
        } label: {
            VStack(spacing: 3) {
                Image(systemName: selected ? tab.activeSymbol : tab.symbol)
                    .font(.title3)
                    .frame(width: 56, height: 32)
                    .background {
                        // M3 active indicator — the icon pill.
                        if selected {
                            Capsule().fill(m3.secondaryContainer)
                        }
                    }
                Text(tab.title)
                    .font(.m3LabelMedium)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .frame(maxWidth: .infinity)
            }
            .foregroundStyle(selected ? m3.onSurface : m3.onSurfaceVariant)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pressScale()
        .accessibilityLabel(tab.title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Transient banner explaining why playback stopped — retry or dismiss.
private struct ErrorBanner: View {
    @Environment(\.m3) private var m3

    let message: String
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.yellow)
            Text(message)
                .font(.m3BodySmall)
                .foregroundStyle(m3.onSurface)
                .lineLimit(2)
            Spacer(minLength: 4)
            Button("Retry", action: retry)
                .font(.m3LabelLarge)
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .font(.m3LabelLarge)
                    .foregroundStyle(m3.onSurfaceVariant)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(12)
        .background(.regularMaterial, in: M3Shape.sheet)
        .shadow(color: .black.opacity(0.15), radius: 10, y: 4)
    }
}
