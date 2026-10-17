//
//  SettingsView.swift
//  Carmen — server URL, lyrics, Live Activities and about. Presented as a
//  sheet from the Library tab (with its own NavigationStack + Done button).
//

import SwiftUI

struct SettingsView: View {
    @Environment(SettingsStore.self) private var settings
    @Environment(Player.self) private var player
    @Environment(DownloadsStore.self) private var downloads
    @Environment(\.dismiss) private var dismiss

    @State private var syncedLyrics = true

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
                        .accessibilityLabel(option.name)
                    }
                }
                .padding(.vertical, 4)
            } header: {
                Text("Appearance")
            } footer: {
                Text("Accent color — defaults to Material Green (#4CAF50), the same palette the web app ships.")
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
            } header: {
                Text("Live Activities")
            } footer: {
                Text("Show the current lyric on the Lock Screen and Dynamic Island while music plays.")
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
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") { dismiss() }
            }
        }
        .onAppear {
            syncedLyrics = player.syncedLyricsEnabled
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
