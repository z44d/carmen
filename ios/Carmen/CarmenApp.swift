//
//  CarmenApp.swift
//  Carmen — app entry point.
//
//  One @MainActor observable store per concern, injected once at the root
//  so every screen (and every sheet) sees the same instances.
//

import SwiftUI

@main
struct CarmenApp: App {
    /// Singletons from the state layer — same instances Player writes to.
    @State private var settings = SettingsStore.shared
    @State private var library = LibraryStore.shared
    @State private var player = Player.shared
    @State private var downloads = DownloadsStore.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(settings)
                .environment(library)
                .environment(player)
                .environment(downloads)
        }
    }
}
