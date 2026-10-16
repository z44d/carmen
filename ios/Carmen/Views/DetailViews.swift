//
//  DetailViews.swift
//  Carmen — the pushed detail screens: album, artist and playlist.
//
//  All three share `DetailHeader` (artwork + title + play/shuffle/…) and the
//  same load-in-`.task` shape: LoadingState → detail, or ErrorState with a
//  retry. The big title lives in the header; the navigation bar stays inline.
//

import SwiftUI

// MARK: - Shared header

/// Big artwork, title, subtitle and the Play / Shuffle / “…” row every
/// detail screen opens with.
private struct DetailHeader: View {
    let title: String
    var subtitle: String = ""
    let artworkURL: String?
    var placeholderSymbol: String = "music.note"
    let tracks: [Track]

    @Environment(Player.self) private var player

    var body: some View {
        VStack(spacing: 14) {
            ArtworkView(url: artworkURL, fallbackURL: nil, cornerRadius: 8, placeholderSymbol: placeholderSymbol)
                .frame(width: 180, height: 180)
            VStack(spacing: 4) {
                Text(title)
                    .font(.largeTitle.bold())
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
                if !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                }
            }
            if !tracks.isEmpty {
                HStack(spacing: 12) {
                    GlassPrimaryButton {
                        player.play(tracks)
                    } label: {
                        Label("Play", systemImage: "play.fill")
                            .font(.body.weight(.semibold))
                    }
                    GlassPlainButton {
                        player.shuffle = true
                        player.play(tracks.shuffled())
                    } label: {
                        Image(systemName: "shuffle")
                            .font(.body.weight(.semibold))
                    }
                    Menu {
                        Button {
                            player.playNext(tracks)
                        } label: {
                            Label("Play Next", systemImage: "text.insert")
                        }
                        Button {
                            for track in tracks { player.enqueue(track) }
                        } label: {
                            Label("Add to Queue", systemImage: "list.bullet.plus")
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.body.weight(.semibold))
                            .frame(width: 44, height: 40)
                    }
                }
            }
        }
        .padding(.horizontal)
        .padding(.top, 8)
    }
}

/// Secondary description text, clamped to `lines` with a More/Less toggle
/// once it actually gets long.
private struct ExpandableText: View {
    let text: String
    var lines: Int = 4

    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(expanded ? nil : lines)
            if text.count > 160 {
                Button(expanded ? "Less" : "More") {
                    withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
                }
                .font(.footnote.weight(.semibold))
            }
        }
        .padding(.horizontal)
    }
}

// MARK: - Album

struct AlbumView: View {
    let browseId: String
    let title: String

    @State private var detail: AlbumDetail?
    @State private var errorMessage: String?

    var body: some View {
        content
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .task(id: browseId) {
                await load()
            }
    }

    @ViewBuilder private var content: some View {
        if let detail {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    DetailHeader(
                        title: detail.title,
                        subtitle: detail.artistLine,
                        artworkURL: detail.artworkURL,
                        placeholderSymbol: "square.stack",
                        tracks: detail.tracks
                    )
                    if let meta = metaLine(detail) {
                        Text(meta)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity)
                    }
                    if let description = detail.description, !description.isEmpty {
                        ExpandableText(text: description)
                    }
                    trackList(album: detail)
                }
                .padding(.bottom, 24)
            }
        } else if let errorMessage {
            ErrorState(message: errorMessage) {
                Task { await load() }
            }
        } else {
            LoadingState()
        }
    }

    private func load() async {
        errorMessage = nil
        do {
            detail = try await API(baseURL: SettingsStore.shared.apiBaseURL).album(browseId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func trackList(album: AlbumDetail) -> some View {
        LazyVStack(spacing: 0) {
            ForEach(Array(album.tracks.enumerated()), id: \.offset) { pair in
                TrackRow(
                    track: pair.element,
                    context: album.tracks,
                    index: pair.offset + 1,
                    showArtwork: false
                )
                .padding(.horizontal)
                .padding(.vertical, 6)
            }
        }
    }

    /// “2015 · 12 songs · 48:12” — whatever the payload gave us.
    private func metaLine(_ album: AlbumDetail) -> String? {
        var parts: [String] = []
        if let year = album.year, !year.isEmpty { parts.append(year) }
        let count = album.trackCount ?? album.tracks.count
        if count > 0 { parts.append("\(count) songs") }
        if let duration = album.duration, !duration.isEmpty { parts.append(duration) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

// MARK: - Artist

struct ArtistView: View {
    let channelId: String
    let title: String

    @State private var detail: ArtistDetail?
    @State private var errorMessage: String?

    var body: some View {
        content
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .task(id: channelId) {
                await load()
            }
    }

    @ViewBuilder private var content: some View {
        if let detail {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    DetailHeader(
                        title: detail.name,
                        subtitle: statsLine(detail),
                        artworkURL: detail.artworkURL,
                        placeholderSymbol: "person.crop.square",
                        tracks: detail.songs
                    )
                    if let description = detail.description, !description.isEmpty {
                        ExpandableText(text: description)
                    }
                    if !detail.songs.isEmpty {
                        popularSection(artist: detail)
                    }
                    cardShelf("Albums", detail.albums)
                    cardShelf("Singles", detail.singles)
                    cardShelf("Related Artists", detail.related)
                }
                .padding(.bottom, 24)
            }
        } else if let errorMessage {
            ErrorState(message: errorMessage) {
                Task { await load() }
            }
        } else {
            LoadingState()
        }
    }

    private func load() async {
        errorMessage = nil
        do {
            detail = try await API(baseURL: SettingsStore.shared.apiBaseURL).artist(channelId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func statsLine(_ artist: ArtistDetail) -> String {
        [artist.subscribers, artist.monthlyListeners]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    private func popularSection(artist: ArtistDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: "Popular")
            ForEach(Array(artist.songs.prefix(6).enumerated()), id: \.offset) { pair in
                TrackRow(
                    track: pair.element,
                    context: artist.songs,
                    index: pair.offset + 1,
                    showArtwork: false
                )
                .padding(.horizontal)
                .padding(.vertical, 6)
            }
        }
    }

    @ViewBuilder private func cardShelf(_ title: String, _ cards: [MediaCard]) -> some View {
        if !cards.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: title)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: 14) {
                        ForEach(cards) { card in
                            CardTile(card: card, siblings: cards, width: 150)
                        }
                    }
                    .padding(.horizontal)
                }
            }
        }
    }
}

// MARK: - Playlist

struct PlaylistView: View {
    let playlistId: String
    let title: String

    @State private var detail: PlaylistDetail?
    @State private var errorMessage: String?

    var body: some View {
        content
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .task(id: playlistId) {
                await load()
            }
    }

    @ViewBuilder private var content: some View {
        if let detail {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    DetailHeader(
                        title: detail.title,
                        subtitle: detail.author ?? "",
                        artworkURL: detail.artworkURL,
                        placeholderSymbol: "music.note.list",
                        tracks: detail.tracks
                    )
                    if let count = trackCount(detail) {
                        Text(count)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity)
                    }
                    if let description = detail.description, !description.isEmpty {
                        ExpandableText(text: description)
                    }
                    trackList(playlist: detail)
                }
                .padding(.bottom, 24)
            }
        } else if let errorMessage {
            ErrorState(message: errorMessage) {
                Task { await load() }
            }
        } else {
            LoadingState()
        }
    }

    private func load() async {
        errorMessage = nil
        // Playlist browse ids may arrive VL-prefixed — the API wants the bare id.
        let id = playlistId.hasPrefix("VL") ? String(playlistId.dropFirst(2)) : playlistId
        do {
            detail = try await API(baseURL: SettingsStore.shared.apiBaseURL).playlist(id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func trackCount(_ playlist: PlaylistDetail) -> String? {
        let count = playlist.trackCount ?? playlist.tracks.count
        return count > 0 ? "\(count) songs" : nil
    }

    private func trackList(playlist: PlaylistDetail) -> some View {
        LazyVStack(spacing: 0) {
            ForEach(Array(playlist.tracks.enumerated()), id: \.offset) { pair in
                TrackRow(track: pair.element, context: playlist.tracks)
                    .padding(.horizontal)
                    .padding(.vertical, 6)
            }
        }
    }
}
