//
//  NetworkMonitor.swift
//  Carmen — one NWPathMonitor for the whole app.
//
//  Two consumers: ArtworkView re-keying itself on `generation` (a cover that
//  failed to load offline reloads the moment connectivity returns) and the
//  Player, which auto-retries a stream that died while offline.
//

import Foundation
import Network
import Observation

@MainActor
@Observable
final class NetworkMonitor {
    static let shared = NetworkMonitor()

    /// Bumped on every path change — views `.id(generation)` to retry loads.
    private(set) var generation = 0
    private(set) var isOnline = true

    private let monitor = NWPathMonitor()

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor [weak self] in
                guard let self else { return }
                let changed = self.isOnline != online
                self.isOnline = online
                if changed {
                    self.generation += 1
                    DebugLog.log("network", online ? "back online" : "offline")
                }
            }
        }
        monitor.start(queue: DispatchQueue(label: "carmen.network"))
    }
}
