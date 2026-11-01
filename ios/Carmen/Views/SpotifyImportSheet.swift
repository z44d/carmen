//
//  SpotifyImportSheet.swift
//  Carmen — the frontend's SpotifyImportDialog as a Material sheet:
//  paste a link → preview the playlist → convert with live per-track
//  progress → review the matches → save them into a local playlist.
//  The server does all the matching; this view only renders its stream.
//

import SwiftUI

struct SpotifyImportSheet: View {
    /// LibraryView opens the freshly saved playlist through this once the
    /// sheet is down (two sheets can't stack in one presentation).
    var onOpenPlaylist: (LocalPlaylist) -> Void = { _ in }

    @Environment(LibraryStore.self) private var library
    @Environment(\.dismiss) private var dismiss
    @Environment(\.m3) private var m3

    private enum Step { case input, preview, converting, results, saved }

    @State private var step: Step = .input
    @State private var link = ""
    @State private var preview: SpotifyPlaylistPreview?
    @State private var playlistName = ""

    // Conversion state — written from `onProgress`, which API.swift hops to
    // the main actor, and guarded by `convertRun` so a cancelled run can
    // never stomp the state of the run that replaced it.
    @State private var done = 0
    @State private var total = 0
    @State private var matchedCount = 0
    @State private var approximateCount = 0
    @State private var currentTitle = ""
    @State private var results: [SpotifyTrackConversion] = []
    @State private var summary: SpotifyConvertSummary?
    @State private var selected: Set<String> = []
    @State private var convertRun = 0
    @State private var convertTask: Task<Void, Never>?

    @State private var savedPlaylist: LocalPlaylist?
    @State private var savedCount = 0
    @State private var busy = false
    @State private var errorMessage: String?

    private var trimmedLink: String { link.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var linkValid: Bool { SpotifyLink.playlistID(link) != nil }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    switch step {
                    case .input: inputStep
                    case .preview: previewStep
                    case .converting: convertingStep
                    case .results: resultsStep
                    case .saved: savedStep
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 32)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollDismissesKeyboard(.interactively)
            .background { m3.background.ignoresSafeArea() }
            .navigationTitle("Spotify import")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close") {
                        stopConverting()
                        dismiss()
                    }
                }
            }
        }
        .onDisappear { stopConverting() }
        .alert("Couldn't import", isPresented: errorBinding) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
    }

    // MARK: - Step 1: input

    @ViewBuilder
    private var inputStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            stepHeader(
                systemImage: "music.note.list",
                title: "Import from Spotify",
                subtitle: "Paste a public Spotify playlist link. Every song is looked up on YouTube Music, and the matches are saved as a playlist in your library."
            )

            HStack(spacing: 10) {
                TextField("https://open.spotify.com/playlist/…", text: $link)
                    .font(.m3BodyLarge)
                    .foregroundStyle(m3.onSurface)
                    .tint(m3.primary)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.go)
                    .onSubmit { if linkValid { fetchPreview() } }
                    .padding(.horizontal, 16)
                    .frame(height: 52)
                    .background(m3.surfaceContainerHigh, in: M3Shape.pill)

                if !link.isEmpty {
                    Button {
                        link = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 17))
                            .foregroundStyle(m3.onSurfaceVariant)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear")
                }
            }

            if !link.isEmpty && !linkValid {
                Text("That doesn't look like a Spotify playlist link. Open the playlist in Spotify → Share → Copy link.")
                    .font(.m3BodySmall)
                    .foregroundStyle(m3.error)
            }

            Button {
                fetchPreview()
            } label: {
                if busy {
                    ProgressView()
                } else {
                    Text("Fetch playlist")
                }
            }
            .buttonStyle(M3FilledStyle())
            .disabled(!linkValid || busy)

            Text("Public playlists only · up to 200 songs.")
                .font(.m3BodySmall)
                .foregroundStyle(m3.onSurfaceVariant)
        }
    }

    // MARK: - Step 2: preview

    @ViewBuilder
    private var previewStep: some View {
        if let preview {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 14) {
                    ArtworkView(url: preview.artwork, cornerRadius: 8, placeholderSymbol: "music.note")
                        .frame(width: 96, height: 96)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(preview.name)
                            .font(.m3TitleMedium)
                            .foregroundStyle(m3.onSurface)
                            .lineLimit(2)
                        Text("\(preview.owner.isEmpty ? "Unknown curator" : preview.owner) · \(preview.trackCount) songs")
                            .font(.m3BodySmall)
                            .foregroundStyle(m3.onSurfaceVariant)
                        if !preview.description.isEmpty {
                            Text(preview.description)
                                .font(.m3BodySmall)
                                .foregroundStyle(m3.onSurfaceVariant)
                                .lineLimit(3)
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    ForEach(preview.tracks.prefix(6)) { track in
                        HStack(spacing: 10) {
                            ArtworkView(url: track.artwork, cornerRadius: 6)
                                .frame(width: 40, height: 40)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(track.title)
                                    .font(.m3BodyMedium)
                                    .foregroundStyle(m3.onSurface)
                                    .lineLimit(1)
                                Text(track.artist)
                                    .font(.m3BodySmall)
                                    .foregroundStyle(m3.onSurfaceVariant)
                                    .lineLimit(1)
                            }
                            Spacer(minLength: 8)
                        }
                    }
                }
                .padding(14)
                .background(m3.surfaceContainerHigh, in: M3Shape.card)

                if preview.trackCount > 0 {
                    Button {
                        startConversion()
                    } label: {
                        Text("Convert \(min(preview.trackCount, 200)) songs")
                    }
                    .buttonStyle(M3FilledStyle())
                } else {
                    Text("This playlist has no songs to import.")
                        .font(.m3BodySmall)
                        .foregroundStyle(m3.onSurfaceVariant)
                }

                Button {
                    step = .input
                } label: {
                    Text("Choose a different link")
                }
                .buttonStyle(M3TonalStyle())
            }
        }
    }

    // MARK: - Step 3: converting (live SSE progress)

    @ViewBuilder
    private var convertingStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            stepHeader(
                systemImage: "arrow.triangle.2.circlepath",
                title: "Converting…",
                subtitle: "Searching YouTube Music for every song in this playlist."
            )

            VStack(alignment: .leading, spacing: 8) {
                ProgressView(value: Double(done), total: Double(max(total, 1)))
                    .tint(Color.carmen)
                HStack {
                    Text("\(done) / \(total) songs")
                    Spacer()
                    Text("\(matchedCount) matched · \(approximateCount) close")
                }
                .font(.m3BodySmall)
                .foregroundStyle(m3.onSurfaceVariant)
                if !currentTitle.isEmpty {
                    Text(currentTitle)
                        .font(.m3BodyMedium)
                        .foregroundStyle(m3.onSurface)
                        .lineLimit(1)
                        .italic()
                }
            }
            .padding(14)
            .background(m3.surfaceContainerHigh, in: M3Shape.card)

            Button {
                stopConverting()
                step = .preview
            } label: {
                Text("Cancel")
            }
            .buttonStyle(M3TonalStyle())
        }
    }

    // MARK: - Step 4: results (select what to save)

    @ViewBuilder
    private var resultsStep: some View {
        if let summary {
            VStack(alignment: .leading, spacing: 16) {
                stepHeader(
                    systemImage: "checkmark.seal",
                    title: "Review the matches",
                    subtitle: "Uncheck anything you don't want. Songs without a match can't be saved."
                )

                HStack(spacing: 8) {
                    statCard(count: summary.matched, label: "Matched", color: m3.primary)
                    statCard(count: summary.approximate, label: "Close", color: m3.tertiary)
                    statCard(count: summary.unusable, label: "No match", color: m3.outline)
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("Playlist name in your library")
                        .font(.m3LabelLarge)
                        .foregroundStyle(m3.onSurfaceVariant)
                    TextField("Name", text: $playlistName)
                        .font(.m3BodyLarge)
                        .foregroundStyle(m3.onSurface)
                        .tint(m3.primary)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(.horizontal, 16)
                        .frame(height: 52)
                        .background(m3.surfaceContainerHigh, in: M3Shape.pill)
                }

                HStack {
                    Text("\(selected.count) selected")
                        .font(.m3BodySmall)
                        .foregroundStyle(m3.onSurfaceVariant)
                    Spacer(minLength: 8)
                    Button("Select all") { selectAll(true) }
                        .buttonStyle(M3TextStyle(compact: true))
                    Button("Clear") { selectAll(false) }
                        .buttonStyle(M3TextStyle(compact: true))
                }

                VStack(alignment: .leading, spacing: 0) {
                    ForEach(results, id: \.spotify.id) { conversion in
                        resultRow(conversion)
                        if conversion.spotify.id != results.last?.spotify.id {
                            Divider()
                        }
                    }
                }
                .padding(.vertical, 4)
                .background(m3.surfaceContainerHigh, in: M3Shape.card)

                Button {
                    save()
                } label: {
                    Text("Save \(selected.count) songs")
                }
                .buttonStyle(M3FilledStyle())
                .disabled(selected.isEmpty)
            }
        }
    }

    private func resultRow(_ conversion: SpotifyTrackConversion) -> some View {
        let id = conversion.spotify.id
        let selectable = conversion.isSelectable
        let isOn = selected.contains(id)
        return Button {
            if selectable { toggle(id) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: selectable ? (isOn ? "checkmark.circle.fill" : "circle") : "minus.circle")
                    .font(.system(size: 20))
                    .foregroundStyle(selectable ? (isOn ? m3.primary : m3.outline) : m3.outlineVariant)
                VStack(alignment: .leading, spacing: 2) {
                    Text(conversion.spotify.title)
                        .font(.m3BodyMedium)
                        .foregroundStyle(m3.onSurface)
                        .lineLimit(1)
                    Text(conversion.spotify.artist)
                        .font(.m3BodySmall)
                        .foregroundStyle(m3.onSurfaceVariant)
                        .lineLimit(1)
                    if let match = conversion.match {
                        Text("→ \(match.title) — \(match.artistLine)")
                            .font(.m3BodySmall)
                            .foregroundStyle(m3.primary)
                            .lineLimit(1)
                    } else if let error = conversion.error, !error.isEmpty {
                        Text(error)
                            .font(.m3BodySmall)
                            .foregroundStyle(m3.error)
                            .lineLimit(1)
                    } else {
                        Text("No match on YouTube Music")
                            .font(.m3BodySmall)
                            .foregroundStyle(m3.outline)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                statusBadge(conversion)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!selectable)
    }

    @ViewBuilder
    private func statusBadge(_ conversion: SpotifyTrackConversion) -> some View {
        switch conversion.status {
        case .matched:
            Text("\(Int((conversion.confidence * 100).rounded()))%")
                .font(.m3LabelSmall)
                .foregroundStyle(m3.onPrimaryContainer)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(m3.primaryContainer, in: M3Shape.capsule)
        case .approximate:
            Text("close")
                .font(.m3LabelSmall)
                .foregroundStyle(m3.onTertiaryContainer)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(m3.tertiaryContainer, in: M3Shape.capsule)
        case .notFound, .error:
            EmptyView()
        }
    }

    // MARK: - Step 5: saved

    @ViewBuilder
    private var savedStep: some View {
        VStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(m3.primaryContainer)
                    .frame(width: 72, height: 72)
                Image(systemName: "checkmark")
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(m3.primary)
            }
            .padding(.top, 24)

            Text("Imported \(savedCount) songs")
                .font(.m3TitleLarge)
                .foregroundStyle(m3.onSurface)

            Text(savedPlaylist?.name ?? playlistName)
                .font(.m3BodyMedium)
                .foregroundStyle(m3.onSurfaceVariant)
                .multilineTextAlignment(.center)

            Button {
                if let savedPlaylist { onOpenPlaylist(savedPlaylist) }
                dismiss()
            } label: {
                Text("Open playlist")
            }
            .buttonStyle(M3FilledStyle())

            Button {
                dismiss()
            } label: {
                Text("Done")
            }
            .buttonStyle(M3TonalStyle())
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Shared pieces

    private func stepHeader(systemImage: String, title: String, subtitle: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle()
                    .fill(m3.primaryContainer)
                    .frame(width: 44, height: 44)
                Image(systemName: systemImage)
                    .font(.m3BodyLarge)
                    .foregroundStyle(m3.primary)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.m3TitleMedium)
                    .foregroundStyle(m3.onSurface)
                Text(subtitle)
                    .font(.m3BodySmall)
                    .foregroundStyle(m3.onSurfaceVariant)
            }
        }
    }

    private func statCard(count: Int, label: String, color: Color) -> some View {
        VStack(spacing: 2) {
            Text("\(count)")
                .font(.m3TitleMedium)
                .foregroundStyle(color)
            Text(label)
                .font(.m3LabelSmall)
                .foregroundStyle(m3.onSurfaceVariant)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(m3.surfaceContainer, in: M3Shape.card)
    }

    private var errorBinding: Binding<Bool> {
        Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )
    }

    // MARK: - Actions

    private func fetchPreview() {
        guard linkValid, !busy else { return }
        busy = true
        errorMessage = nil
        let request = trimmedLink
        Task {
            do {
                let info = try await API(baseURL: SettingsStore.shared.apiBaseURL)
                    .spotifyPlaylist(request)
                preview = info
                playlistName = info.name
                step = .preview
            } catch {
                errorMessage = error.localizedDescription
            }
            busy = false
        }
    }

    private func startConversion() {
        guard let preview else { return }
        step = .converting
        done = 0
        total = preview.trackCount
        matchedCount = 0
        approximateCount = 0
        currentTitle = ""
        results = []
        summary = nil
        selected = []
        errorMessage = nil

        convertRun += 1
        let run = convertRun
        let request = trimmedLink
        let limit = min(200, max(preview.trackCount, 1))

        convertTask = Task {
            defer { if run == convertRun { convertTask = nil } }
            do {
                let outcome = try await API(baseURL: SettingsStore.shared.apiBaseURL)
                    .convertSpotifyPlaylist(request, limit: limit) { event in
                        guard run == convertRun else { return }
                        done = event.done
                        total = event.total
                        currentTitle = event.result.spotify.title
                        if event.result.status == .matched { matchedCount += 1 }
                        if event.result.status == .approximate { approximateCount += 1 }
                    }
                guard run == convertRun else { return }
                results = outcome.results
                summary = outcome.summary
                selected = Set(outcome.results.filter(\.isSelectable).map { $0.spotify.id })
                step = .results
            } catch {
                guard run == convertRun else { return }
                let cancelled = Task.isCancelled
                    || (error as? URLError)?.code == URLError.Code.cancelled
                if !cancelled {
                    errorMessage = error.localizedDescription
                }
                step = .preview
            }
        }
    }

    /// Invalidates the running conversion (token first, so neither its
    /// progress callbacks nor its completion can write state afterwards).
    private func stopConverting() {
        convertRun += 1
        convertTask?.cancel()
        convertTask = nil
    }

    private func toggle(_ id: String) {
        if selected.contains(id) {
            selected.remove(id)
        } else {
            selected.insert(id)
        }
    }

    private func selectAll(_ on: Bool) {
        if on {
            selected = Set(results.filter(\.isSelectable).map { $0.spotify.id })
        } else {
            selected = []
        }
    }

    private func save() {
        let typed = playlistName.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = preview?.name ?? ""
        let name = typed.isEmpty
            ? (fallback.isEmpty ? "Imported from Spotify" : fallback)
            : typed
        let tracks = results
            .filter { selected.contains($0.spotify.id) }
            .compactMap(\.match)
        let created = library.createPlaylist(named: name)
        library.addTracks(tracks, toPlaylist: created.id)
        savedPlaylist = created
        savedCount = library.playlist(id: created.id)?.tracks.count ?? tracks.count
        step = .saved
    }
}
