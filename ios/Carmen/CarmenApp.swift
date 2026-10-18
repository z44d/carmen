//
//  CarmenApp.swift
//  Carmen — app entry point.
//
//  One @MainActor observable store per concern, injected once at the root
//  so every screen (and every sheet) sees the same instances.
//

import SwiftUI
import UIKit

@main
struct CarmenApp: App {
    /// iOS relaunches the app in the background when a download finishes or
    /// needs events delivered — the delegate hands the completion handler to
    /// DownloadsStore once the session drains its queue.
    @UIApplicationDelegateAdaptor(CarmenAppDelegate.self) private var appDelegate

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

final class CarmenAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        Task { @MainActor in
            // Touching the store also (re)creates the background session, so
            // the delegate is attached before the pending events arrive.
            DownloadsStore.shared.backgroundCompletionHandler = completionHandler
        }
    }
}
