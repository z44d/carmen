//
//  Settings.swift
//  Carmen — user settings, persisted in UserDefaults.
//
//  @Observable stores persist through their property setters rather than
//  `didSet`, so every mutation is a save without call-site discipline.
//

import Foundation
import Observation

/// Lyrics provider selector — `auto` follows the backend's resolution chain
/// (YouTube timed lyrics → ytmusicapi plain → syncedlyrics), forced providers
/// query only that source. Mirrors LYRICS_PROVIDERS on the web.
enum LyricsProvider: String, CaseIterable, Identifiable, Sendable {
    case auto, lrclib, musixmatch, netease, megalobiz, genius

    var id: String { rawValue }

    var label: String {
        switch self {
        case .auto: return "Auto"
        case .lrclib: return "LRCLIB"
        case .musixmatch: return "Musixmatch"
        case .netease: return "NetEase"
        case .megalobiz: return "Megalobiz"
        case .genius: return "Genius"
        }
    }
}

/// Accent color choices — the same Material palette the web client ships in
/// `frontend/src/theme.ts`, defaulting to Material Green (#4CAF50).
enum AccentOption: String, CaseIterable, Identifiable, Sendable {
    case green, emerald, teal, lime, cyan, blue, indigo, purple, pink, red, orange, amber, white

    var id: String { rawValue }

    var name: String {
        switch self {
        case .green: return "Green"
        case .emerald: return "Emerald"
        case .teal: return "Teal"
        case .lime: return "Lime"
        case .cyan: return "Cyan"
        case .blue: return "Blue"
        case .indigo: return "Indigo"
        case .purple: return "Purple"
        case .pink: return "Pink"
        case .red: return "Red"
        case .orange: return "Orange"
        case .amber: return "Amber"
        case .white: return "White"
        }
    }

    /// Hex value identical to the web palette so both clients theme alike.
    var hex: String {
        switch self {
        case .green: return "#4CAF50"
        case .emerald: return "#10B981"
        case .teal: return "#009688"
        case .lime: return "#8BC34A"
        case .cyan: return "#00BCD4"
        case .blue: return "#2196F3"
        case .indigo: return "#3F51B5"
        case .purple: return "#9C27B0"
        case .pink: return "#E91E63"
        case .red: return "#F44336"
        case .orange: return "#FF5722"
        case .amber: return "#FF9800"
        case .white: return "#ffffff"
        }
    }
}

@MainActor
@Observable
final class SettingsStore {
    static let defaultBaseURL = "https://api-carmen-v1.syr.qzz.io"

    /// Shared instance (Player reads the base URL and lyrics provider from it).
    /// Views should use this same instance via `@Environment`.
    static let shared = SettingsStore()

    private enum Key {
        static let apiBase = "settings.apiBase"
        static let lyricsProvider = "settings.lyricsProvider"
        static let liveActivities = "settings.liveActivities"
        static let accent = "settings.accent"
    }

    @ObservationIgnored private let defaults: UserDefaults = .standard

    private var _apiBase: String
    private var _lyricsProviderRaw: String
    private var _liveActivitiesEnabled: Bool
    private var _accentRaw: String

    /// Server URL without a trailing slash; empty string means "use the default".
    var apiBase: String {
        get { _apiBase }
        set {
            _apiBase = newValue
            defaults.set(newValue, forKey: Key.apiBase)
        }
    }

    var lyricsProvider: LyricsProvider {
        get { LyricsProvider(rawValue: _lyricsProviderRaw) ?? .auto }
        set {
            _lyricsProviderRaw = newValue.rawValue
            defaults.set(newValue.rawValue, forKey: Key.lyricsProvider)
        }
    }

    /// Whether the lyric Live Activity may be started/updated.
    var liveActivitiesEnabled: Bool {
        get { _liveActivitiesEnabled }
        set {
            _liveActivitiesEnabled = newValue
            defaults.set(newValue, forKey: Key.liveActivities)
        }
    }

    /// The user-chosen accent color (theme). Drives the whole app's tint.
    var accent: AccentOption {
        get { AccentOption(rawValue: _accentRaw) ?? .green }
        set {
            _accentRaw = newValue.rawValue
            defaults.set(newValue.rawValue, forKey: Key.accent)
        }
    }

    init() {
        _apiBase = defaults.string(forKey: Key.apiBase) ?? ""
        _lyricsProviderRaw = defaults.string(forKey: Key.lyricsProvider) ?? LyricsProvider.auto.rawValue
        _liveActivitiesEnabled = defaults.object(forKey: Key.liveActivities) as? Bool ?? true
        _accentRaw = defaults.string(forKey: Key.accent) ?? AccentOption.green.rawValue
    }

    /// Effective base URL (trimmed, default fallback) — build a client with it.
    var apiBaseURL: URL {
        let trimmed = apiBase.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidate = trimmed.contains("://") ? trimmed : "http://\(trimmed)"
        let slashed = candidate.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if !slashed.isEmpty,
            let url = URL(string: slashed),
            let scheme = url.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            url.host != nil
        {
            return url
        }
        return URL(string: Self.defaultBaseURL)!
    }

    /// `nil` for auto — the server treats an absent provider as its default chain.
    var lyricsProviderParam: String? {
        lyricsProvider == .auto ? nil : lyricsProvider.rawValue
    }

    func resetServerURL() {
        apiBase = ""
    }
}
