//
//  RootView.swift
//  Carmen — the four-tab shell (Home / Search / Library / Settings), the
//  floating mini player and the full Now Playing overlay.
//
//  Each tab owns its own NavigationStack; the mini player floats above the
//  tab bar. The full player is an overlay driven by the Player's
//  `expansion` (0 = parked below screen on the mini bar, 1 = full) so it can
//  be dragged open and closed interactively.
//

import SwiftUI

struct RootView: View {
    @Environment(Player.self) private var player

    @State private var selectedTab: Tab = .home

    enum Tab: Hashable {
        case home, search, library, settings
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            TabView(selection: $selectedTab) {
                NavigationStack {
                    HomeView()
                        .carmenDestinations()
                }
                .tabItem { Label("Home", systemImage: "house") }
                .tag(Tab.home)

                NavigationStack {
                    SearchView()
                        .carmenDestinations()
                }
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
                .tag(Tab.search)

                NavigationStack {
                    LibraryView()
                        .carmenDestinations()
                }
                .tabItem { Label("Library", systemImage: "square.stack") }
                .tag(Tab.library)

                NavigationStack {
                    SettingsView(embeddedInTab: true)
                }
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(Tab.settings)
            }

            // Mini player floats just above the tab bar when something is
            // queued — it cross-fades out as the full player expands over it.
            if player.hasQueue {
                MiniPlayer()
                    .padding(.horizontal, 8)
                    .padding(.bottom, 49)  // tab bar height + margin
                    .opacity(player.showNowPlaying ? max(0, 1 - player.expansion * 2) : 1)
                    .scaleEffect(player.showNowPlaying ? max(0.92, 1 - player.expansion * 0.08) : 1)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            // Full player: slides up from the mini bar's position — mounted at
            // expansion 0, then animated to 1 (openPlayer), and drag-tracked
            // back down inside NowPlayingView. Fixed travel (taller than any
            // iPhone) so the view is fully parked off-screen at expansion 0.
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
        .tint(Color.carmen)
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
    }
}

/// Transient banner explaining why playback stopped — retry or dismiss.
private struct ErrorBanner: View {
    let message: String
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.yellow)
            Text(message)
                .font(.footnote)
                .lineLimit(2)
            Spacer(minLength: 4)
            Button("Retry", action: retry)
                .font(.footnote.weight(.semibold))
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(color: .black.opacity(0.15), radius: 10, y: 4)
    }
}
