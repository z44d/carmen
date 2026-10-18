//
//  SettingsView.swift
//  Carmen — server URL, appearance, lyrics, Live Activities, storage,
//  diagnostics and about. Presented either as a tab (4th tab, no Done) or
//  as a sheet from the Library tab (with its own Done button).
//

import SwiftUI

struct SettingsView: View {
    /// `true` when hosted in the Settings tab — no Done button, the tab bar
    /// already handles leaving.
    var embeddedInTab = false

    @Environment(SettingsStore.self) private var settings
    @Environment(Player.self) private var player
    @Environment(DownloadsStore.self) private var downloads
    @Environment(\.dismiss) private var dismiss

    @State private var syncedLyrics = true
    @State private var logSize = DebugLog.sizeLabel

    private let swatchColumns = [GridItem(.adaptive(minimum: 44), spacing: 12)]

    var body: some View {
        @Bindable var settings = settings

        List {
            Section {
                TextField("Server URL", text: $settings.apiBase)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                Button("Reset to Default") {
                    settings.resetServerURL()
                }
            } header: {
                Text("Server")
            } footer: {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Using: \(settings.apiBaseURL.absoluteString)")
                    Text(
                        "Default: \(SettingsStore.defaultBaseURL) — leave empty to use it. e.g. http://192.168.1.5:8000 for a LAN dev server."
                    )
                }
            }

            Section {
                Toggle("Adaptive Accent", isOn: $settings.adaptiveAccentEnabled)
                LazyVGrid(columns: swatchColumns, spacing: 12) {
                    ForEach(AccentOption.allCases) { option in
                        Button {
                            settings.accent = option
                        } label: {
                            Circle()
                                .fill(Color(hex: option.hex))
                                .frame(width: 30, height: 30)
                                .overlay {
                                    Circle().strokeBorder(.secondary.opacity(0.35), lineWidth: 0.5)
                                }
                                .overlay {
                                    if settings.accent == option {
                                        Circle().strokeBorder(Color.primary, lineWidth: 2)
                                    }
                                }
                        }
                        .buttonStyle(.plain)
                        .opacity(settings.adaptiveAccentEnabled ? 0.45 : 1)
                        .accessibilityLabel(option.name)
                    }
                }
                .padding(.vertical, 4)
                .disabled(settings.adaptiveAccentEnabled)
            } header: {
                Text("Appearance")
            } footer: {
                Text(
                    "Adaptive Accent lets the album cover pick the color — the player, buttons and highlights follow the record, like Apple Music. When off, the chosen palette accent applies everywhere: defaults to Material Green (#4CAF50), the same palette the web app ships."
                )
            }

            Section {
                Picker("Provider", selection: $settings.lyricsProvider) {
                    ForEach(LyricsProvider.allCases) { provider in
                        Text(provider.label).tag(provider)
                    }
                }
                .pickerStyle(.menu)
                Toggle("Synced (timed) Lyrics", isOn: $syncedLyrics)
            } header: {
                Text("Lyrics")
            } footer: {
                Text("Auto follows the backend chain: YouTube timed lyrics, then ytmusicapi, then syncedlyrics.")
            }

            Section {
                Toggle("Lyric Live Activities", isOn: $settings.liveActivitiesEnabled)
                Toggle("Download Live Activities", isOn: $settings.downloadLiveActivitiesEnabled)
            } header: {
                Text("Live Activities")
            } footer: {
                Text(
                    "Lyrics show the current line on the Lock Screen and Dynamic Island while music plays; downloads show how many bytes have landed so far."
                )
            }

            Section {
                LabeledContent("Downloaded Songs", value: "\(downloads.downloadedIds.count)")
                LabeledContent("Storage Used", value: downloads.totalSizeLabel)
                if !downloads.downloadedIds.isEmpty {
                    Button("Remove All Downloads", role: .destructive) {
                        downloads.removeAll()
                    }
                }
            } header: {
                Text("Storage")
            } footer: {
                Text("A download keeps the audio, artwork and lyrics on the device — the song then plays and shows its lyrics fully offline.")
            }

            Section {
                LabeledContent("Log Size", value: logSize)
                ShareLink(item: DebugLog.fileURL) {
                    Label("Share Debug Log", systemImage: "square.and.arrow.up")
                }
                Button("Clear Log") {
                    DebugLog.clear()
                    logSize = DebugLog.sizeLabel
                }
            } header: {
                Text("Diagnostics")
            } footer: {
                Text(
                    "Every API call, stream fetch, playback transition and download writes a line to this log. If a song refuses to play, share it and the real reason is in there."
                )
            }

            Section {
                LabeledContent("Version", value: appVersion)
                Link(destination: URL(string: "https://github.com/z44d/carmen")!) {
                    Label("Open-Source API", systemImage: "server.rack")
                }
                Link(destination: URL(string: "https://github.com/z44d/carmen")!) {
                    Label("Source Code", systemImage: "chevron.left.forwardslash.chevron.right")
                }
            } header: {
                Text("About")
            } footer: {
                Text("Carmen plays YouTube Music through the Carmen API.")
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Settings")
        .toolbar {
            if !embeddedInTab {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onAppear {
            syncedLyrics = player.syncedLyricsEnabled
            logSize = DebugLog.sizeLabel
        }
        .onChange(of: syncedLyrics) { _, newValue in
            player.syncedLyricsEnabled = newValue
            player.reloadLyrics()
        }
    }

    private var appVersion: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
        return version.isEmpty ? "1.0.0" : version
    }
}
