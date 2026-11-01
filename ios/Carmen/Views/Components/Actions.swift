//
//  Actions.swift
//  Carmen — per-track actions shared by rows, tiles and menus.
//
//  Ported verbatim from the old shared Components.swift: same signatures,
//  same LibraryStore/DownloadsStore calls, same live-accent (Color.carmen)
//  coloring — only the surrounding chrome changed.
//

import SwiftUI

/// Trailing heart that toggles a song as a favorite (Apple Music placement).
struct FavoriteButton: View {
    let track: Track

    @Environment(LibraryStore.self) private var library

    private var isFavorite: Bool { library.isFavorite(track.videoId) }

    var body: some View {
        Button {
            library.toggleFavorite(track)
        } label: {
            Image(systemName: isFavorite ? "heart.fill" : "heart")
                .font(.footnote)
                .foregroundStyle(isFavorite ? Color.carmen : Color.secondary)
                .frame(width: 32, height: 32)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isFavorite ? "Remove Favorite" : "Favorite")
    }
}

/// The circular download control: idle → progress ring (with % when the
/// server declared a size) → check, tap again removes. Mirrors the web
/// client's DownloadButton, including the failure alert.
struct DownloadButton: View {
    let track: Track
    var diameter: CGFloat = 24

    @Environment(DownloadsStore.self) private var downloads

    private var state: DownloadsStore.State? { downloads.state(for: track.videoId) }

    var body: some View {
        Button {
            if downloads.isDownloaded(track.videoId) || state != nil {
                downloads.remove(videoId: track.videoId)
            } else {
                downloads.download(track)
            }
        } label: {
            label
                .frame(width: diameter + 12, height: diameter + 12)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .alert(
            "Download Failed",
            isPresented: Binding(
                get: { downloads.failedIds.contains(track.videoId) },
                set: { presented in
                    if !presented { downloads.acknowledgeFailure(track.videoId) }
                }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("The download for “\(track.title)” could not be saved.")
        }
        .accessibilityLabel(labelDescription)
    }

    @ViewBuilder private var label: some View {
        switch state {
        case .running(let progress):
            ZStack {
                Circle()
                    .stroke(Color.secondary.opacity(0.25), lineWidth: 2)
                Circle()
                    .trim(from: 0, to: max(progress, 0.02))
                    .stroke(Color.carmen, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                if progress > 0.05 {
                    Text("\(Int((progress * 100).rounded()))")
                        .font(.system(size: diameter * 0.4, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(Color.carmen)
                }
            }
            .frame(width: diameter, height: diameter)
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: diameter))
                .foregroundStyle(Color.carmen)
        case nil:
            Image(systemName: "arrow.down.circle")
                .font(.system(size: diameter + 2))
                .foregroundStyle(Color.secondary)
        }
    }

    private var labelDescription: String {
        switch state {
        case .running: return "Downloading"
        case .done: return "Downloaded — tap to remove"
        case nil: return downloads.isDownloaded(track.videoId) ? "Downloaded" : "Download"
        }
    }
}

/// Context-menu rows for a track's download state (used inside `Menu`s and
/// sheet menus alike).
struct DownloadMenuItems: View {
    let track: Track

    @Environment(DownloadsStore.self) private var downloads

    var body: some View {
        if downloads.isDownloaded(track.videoId) {
            Button(role: .destructive) {
                downloads.remove(videoId: track.videoId)
            } label: {
                Label("Remove Download", systemImage: "trash")
            }
        } else {
            Button {
                downloads.download(track)
            } label: {
                Label("Download", systemImage: "arrow.down.circle")
            }
        }
    }
}

/// Sub-menu of the current local playlists + "New Playlist…".
struct PlaylistPickerMenu: View {
    let track: Track

    @Environment(LibraryStore.self) private var library
    @State private var showingNewPlaylist = false
    @State private var newName = ""

    var body: some View {
        Menu {
            if library.playlists.isEmpty {
                Text("No playlists yet")
            } else {
                ForEach(library.playlists) { playlist in
                    Button {
                        library.toggleTrack(track, inPlaylist: playlist.id)
                    } label: {
                        if library.isSaved(inPlaylist: playlist.id, videoId: track.videoId) {
                            Label(playlist.name, systemImage: "checkmark")
                        } else {
                            Text(playlist.name)
                        }
                    }
                }
            }
            Divider()
            Button {
                showingNewPlaylist = true
            } label: {
                Label("New Playlist…", systemImage: "plus")
            }
        } label: {
            Label("Add to Playlist…", systemImage: "music.note.list")
        }
        .alert("New Playlist", isPresented: $showingNewPlaylist) {
            TextField("Name", text: $newName)
            Button("Create") {
                let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty else { return }
                let created = library.createPlaylist(named: name)
                library.toggleTrack(track, inPlaylist: created.id)
                newName = ""
            }
            Button("Cancel", role: .cancel) { newName = "" }
        }
    }
}
