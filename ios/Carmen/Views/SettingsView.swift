//
//  SettingsView.swift
//  Carmen — Material 3 settings hub: server URL, appearance, lyrics, Live
//  Activities, storage, diagnostics and about. Presented either as a tab
//  (RootView already hosts a NavigationStack, so no Done) or as a sheet
//  from Home/Search/Library — in sheet mode it brings its own
//  NavigationStack so a Done button can always dismiss it.
//
//  Anatomy mirrors Android's SettingsScreen: a large "Settings" app bar,
//  then grouped cards, each row = 40pt icon badge + title/subtitle +
//  trailing control, hairline dividers between rows.
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
    @Environment(\.m3) private var m3

    @State private var syncedLyrics = true
    @State private var logSize = DebugLog.sizeLabel

    private let swatchColumns = [GridItem(.adaptive(minimum: 44), spacing: 12)]

    var body: some View {
        // Sheets from Home/Search present us bare, so non-embedded mode has
        // to bring the stack itself; the tab already lives in one.
        if embeddedInTab {
            settingsContent
        } else {
            // Library wraps us in its own stack too — the extra hidden
            // suppresses that outer bar so only our TopAppBar shows.
            NavigationStack { settingsContent }
                .toolbar(.hidden, for: .navigationBar)
        }
    }

    private var settingsContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                serverSection
                appearanceSection
                lyricsSection
                liveActivitiesSection
                storageSection
                diagnosticsSection
                aboutSection
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .padding(.bottom, 32)
        }
        .background { m3.background.ignoresSafeArea() }
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .top) {
            TopAppBar(
                title: "Settings",
                large: true,
                showOverflow: false,
                trailing: {
                    if !embeddedInTab {
                        Button("Done") { dismiss() }
                            .font(.m3LabelLarge)
                            .foregroundStyle(m3.primary)
                            .accessibilityLabel("Close Settings")
                    }
                }
            )
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

    // MARK: - Server

    @ViewBuilder private var serverSection: some View {
        @Bindable var settings = settings

        SettingsGroup("Server") {
            M3Card(padding: 0) {
                HStack(spacing: 14) {
                    SettingsIconBadge(systemImage: "server.rack")
                    TextField("Server URL", text: $settings.apiBase)
                        .font(.m3BodyLarge)
                        .foregroundStyle(m3.onSurface)
                        .tint(m3.primary)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("Reset") {
                        settings.resetServerURL()
                    }
                    .font(.m3LabelLarge)
                    .foregroundStyle(m3.primary)
                    .accessibilityLabel("Reset to Default")
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 64)
            }
            VStack(alignment: .leading, spacing: 4) {
                SettingsFooter("Using: \(settings.apiBaseURL.absoluteString)")
                SettingsFooter(
                    "Default: \(SettingsStore.defaultBaseURL) — leave empty to use it. e.g. http://192.168.1.5:8000 for a LAN dev server."
                )
            }
        }
    }

    // MARK: - Appearance

    @ViewBuilder private var appearanceSection: some View {
        @Bindable var settings = settings

        SettingsGroup("Appearance") {
            M3Card(padding: 0) {
                SettingsRow(icon: "paintpalette", title: "Adaptive Accent") {
                    Toggle("", isOn: $settings.adaptiveAccentEnabled)
                        .labelsHidden()
                        .tint(Color.carmenControlTint)
                }
            }

            M3Card {
                LazyVGrid(columns: swatchColumns, spacing: 12) {
                    ForEach(AccentOption.allCases) { option in
                        Button {
                            settings.accent = option
                        } label: {
                            Circle()
                                .fill(Color(hex: option.hex))
                                .frame(width: 30, height: 30)
                                .overlay {
                                    Circle().strokeBorder(m3.outlineVariant, lineWidth: 0.5)
                                }
                                .overlay {
                                    if settings.accent == option {
                                        Circle().strokeBorder(m3.primary, lineWidth: 2)
                                    }
                                }
                        }
                        .buttonStyle(.plain)
                        .opacity(settings.adaptiveAccentEnabled ? 0.45 : 1)
                        .accessibilityLabel(option.name)
                    }
                }
                .frame(maxWidth: .infinity)
                .disabled(settings.adaptiveAccentEnabled)
            }

            SettingsFooter(
                "Adaptive Accent lets the album cover pick the color — the player, buttons and highlights follow the record, like Apple Music. When off, the chosen palette accent applies everywhere: defaults to Material Green (#4CAF50), the same palette the web app ships."
            )
        }
    }

    // MARK: - Lyrics

    @ViewBuilder private var lyricsSection: some View {
        @Bindable var settings = settings

        SettingsGroup("Lyrics") {
            M3Card(padding: 0) {
                VStack(spacing: 0) {
                    SettingsRow(icon: "quote.bubble", title: "Provider") {
                        Menu {
                            ForEach(LyricsProvider.allCases) { provider in
                                Button {
                                    settings.lyricsProvider = provider
                                } label: {
                                    if settings.lyricsProvider == provider {
                                        Label(provider.label, systemImage: "checkmark")
                                    } else {
                                        Text(provider.label)
                                    }
                                }
                            }
                        } label: {
                            HStack(spacing: 4) {
                                Text(settings.lyricsProvider.label)
                                    .font(.m3BodyMedium)
                                    .foregroundStyle(m3.onSurfaceVariant)
                                Image(systemName: "chevron.down")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(m3.onSurfaceVariant)
                            }
                        }
                    }
                    SettingsDivider()
                    SettingsRow(icon: "captions.bubble", title: "Synced (timed) Lyrics") {
                        Toggle("", isOn: $syncedLyrics)
                            .labelsHidden()
                            .tint(Color.carmenControlTint)
                    }
                }
            }
            SettingsFooter("Auto follows the backend chain: YouTube timed lyrics, then ytmusicapi, then syncedlyrics.")
        }
    }

    // MARK: - Live Activities

    @ViewBuilder private var liveActivitiesSection: some View {
        @Bindable var settings = settings

        SettingsGroup("Live Activities") {
            M3Card(padding: 0) {
                VStack(spacing: 0) {
                    SettingsRow(icon: "music.note", title: "Lyric Live Activities") {
                        Toggle("", isOn: $settings.liveActivitiesEnabled)
                            .labelsHidden()
                            .tint(Color.carmenControlTint)
                    }
                    SettingsDivider()
                    SettingsRow(icon: "arrow.down.circle", title: "Download Live Activities") {
                        Toggle("", isOn: $settings.downloadLiveActivitiesEnabled)
                            .labelsHidden()
                            .tint(Color.carmenControlTint)
                    }
                }
            }
            SettingsFooter(
                "Lyrics show the current line on the Lock Screen and Dynamic Island while music plays; downloads show how many bytes have landed so far."
            )
        }
    }

    // MARK: - Storage

    @ViewBuilder private var storageSection: some View {
        SettingsGroup("Storage") {
            M3Card(padding: 0) {
                VStack(spacing: 0) {
                    SettingsRow(icon: "music.note.list", title: "Downloaded Songs") {
                        Text("\(downloads.downloadedIds.count)")
                            .font(.m3BodyMedium)
                            .foregroundStyle(m3.onSurfaceVariant)
                    }
                    if !downloads.downloadedIds.isEmpty {
                        SettingsDivider()
                    }
                    SettingsRow(icon: "internaldrive", title: "Storage Used") {
                        Text(downloads.totalSizeLabel)
                            .font(.m3BodyMedium)
                            .foregroundStyle(m3.onSurfaceVariant)
                    }
                    if !downloads.downloadedIds.isEmpty {
                        SettingsDivider()
                        Button(role: .destructive) {
                            downloads.removeAll()
                        } label: {
                            SettingsRow(icon: "trash", title: "Remove All Downloads", tint: m3.error)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            SettingsFooter(
                "A download keeps the audio, artwork and lyrics on the device — the song then plays and shows its lyrics fully offline."
            )
        }
    }

    // MARK: - Diagnostics

    @ViewBuilder private var diagnosticsSection: some View {
        SettingsGroup("Diagnostics") {
            M3Card(padding: 0) {
                VStack(spacing: 0) {
                    SettingsRow(icon: "doc.text", title: "Log Size") {
                        Text(logSize)
                            .font(.m3BodyMedium)
                            .foregroundStyle(m3.onSurfaceVariant)
                    }
                    SettingsDivider()
                    ShareLink(item: DebugLog.fileURL) {
                        SettingsRow(icon: "square.and.arrow.up", title: "Share Debug Log") {
                            rowChevron
                        }
                    }
                    SettingsDivider()
                    Button {
                        DebugLog.clear()
                        logSize = DebugLog.sizeLabel
                    } label: {
                        SettingsRow(icon: "xmark.bin", title: "Clear Log", tint: m3.primary)
                    }
                    .buttonStyle(.plain)
                }
            }
            SettingsFooter(
                "Every API call, stream fetch, playback transition and download writes a line to this log. If a song refuses to play, share it and the real reason is in there."
            )
        }
    }

    // MARK: - About

    @ViewBuilder private var aboutSection: some View {
        SettingsGroup("About") {
            M3Card(padding: 0) {
                VStack(spacing: 0) {
                    SettingsRow(icon: "info.circle", title: "Version") {
                        Text(appVersion)
                            .font(.m3BodyMedium)
                            .foregroundStyle(m3.onSurfaceVariant)
                    }
                    SettingsDivider()
                    Link(destination: URL(string: "https://github.com/z44d/carmen")!) {
                        SettingsRow(icon: "server.rack", title: "Open-Source API") {
                            rowChevron
                        }
                    }
                    SettingsDivider()
                    Link(destination: URL(string: "https://github.com/z44d/carmen")!) {
                        SettingsRow(
                            icon: "chevron.left.forwardslash.chevron.right",
                            title: "Source Code"
                        ) {
                            rowChevron
                        }
                    }
                }
            }
            SettingsFooter("Carmen plays YouTube Music through the Carmen API.")
        }
    }

    private var rowChevron: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(m3.onSurfaceVariant.opacity(0.4))
    }

    private var appVersion: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
        return version.isEmpty ? "1.0.0" : version
    }
}

// MARK: - Settings building blocks

/// Group header label + card stack (Android's section label + segmented card).
private struct SettingsGroup<Content: View>: View {
    var label: String
    private let content: () -> Content

    @Environment(\.m3) private var m3

    init(_ label: String, @ViewBuilder content: @escaping () -> Content) {
        self.label = label
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(label.uppercased())
                .font(.m3TitleSmall)
                .kerning(0.8)
                .foregroundStyle(m3.onSurfaceVariant)
                .padding(.leading, 4)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// 40pt icon badge in a primary-container circle, icon tinted primary —
/// the leading element of every settings row.
private struct SettingsIconBadge: View {
    var systemImage: String

    @Environment(\.m3) private var m3

    var body: some View {
        Circle()
            .fill(m3.primaryContainer)
            .frame(width: 40, height: 40)
            .overlay {
                Image(systemName: systemImage)
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(m3.primary)
            }
    }
}

/// Row anatomy: badge + title/subtitle + trailing control. Plain rows read
/// as content; buttons, links and ShareLinks reuse it as their label.
private struct SettingsRow<Trailing: View>: View {
    var icon: String
    var title: String
    var subtitle: String? = nil
    /// Destructive / action-row title tint (defaults to on-surface).
    var tint: Color? = nil

    private let trailing: () -> Trailing

    @Environment(\.m3) private var m3

    init(
        icon: String,
        title: String,
        subtitle: String? = nil,
        tint: Color? = nil,
        @ViewBuilder trailing: @escaping () -> Trailing = { EmptyView() }
    ) {
        self.icon = icon
        self.title = title
        self.subtitle = subtitle
        self.tint = tint
        self.trailing = trailing
    }

    var body: some View {
        HStack(spacing: 14) {
            SettingsIconBadge(systemImage: icon)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.m3BodyLarge)
                    .fontWeight(.medium)
                    .foregroundStyle(tint ?? m3.onSurface)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                if let subtitle {
                    Text(subtitle)
                        .font(.m3BodyMedium)
                        .foregroundStyle(m3.onSurfaceVariant)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            trailing()
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 64)
        .contentShape(Rectangle())
    }
}

/// Hairline separator between rows, inset past the icon badge.
private struct SettingsDivider: View {
    @Environment(\.m3) private var m3

    var body: some View {
        Rectangle()
            .fill(m3.outlineVariant)
            .frame(height: 0.5)
            .padding(.leading, 70)
    }
}

/// Supporting text under a card (the old List section footers).
private struct SettingsFooter: View {
    var text: String

    @Environment(\.m3) private var m3

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text)
            .font(.m3BodyMedium)
            .foregroundStyle(m3.onSurfaceVariant)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
