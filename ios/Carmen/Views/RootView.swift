//
//  RootView.swift
//  Carmen — the three-tab shell (Home / Search / Library), the floating mini
//  player and the full-screen Now Playing cover.
//
//  Each tab owns its own NavigationStack; the mini player floats above the
//  tab bar and the Now Playing screen is presented as a full-screen cover
//  from the Player's `showNowPlaying` flag.
//

import SwiftUI

struct RootView: View {
    @Environment(Player.self) private var player
    @Environment(SettingsStore.self) private var settings
    @Environment(LibraryStore.self) private var library

    @State private var selectedTab: Tab = .home

    enum Tab: Hashable {
        case home, search, library
    }

    var body: some View {
        @Bindable var player = player

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
            }

            // Mini player floats just above the tab bar when something is queued.
            if player.hasQueue {
                MiniPlayer()
                    .padding(.horizontal, 8)
                    .padding(.bottom, 49)  // tab bar height + margin
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.snappy(duration: 0.25), value: player.hasQueue)
        // Stream failure banner — sits above everything while the player is stuck.
        .overlay(alignment: .top) {
            if let message = player.errorMessage {
                ErrorBanner(message: message) { player.retry() }
                    .padding(.horizontal, 12)
                    .padding(.top, 4)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.snappy(duration: 0.2), value: player.errorMessage)
        .fullScreenCover(isPresented: $player.showNowPlaying) {
            NowPlayingView()
                .environment(player)
                .environment(library)
                .environment(settings)
        }
        .task {
            // Re-attach the lyric Live Activity if one outlived the app.
            LyricActivityController.shared.adoptExisting()
        }
    }
}

/// Transient banner explaining why playback stopped, with a retry.
private struct ErrorBanner: View {
    let message: String
    let retry: () -> Void

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
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(color: .black.opacity(0.15), radius: 10, y: 4)
    }
}
