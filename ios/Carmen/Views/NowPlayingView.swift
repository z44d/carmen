//
//  NowPlayingView.swift
//  Carmen — the full-screen player: artwork (or lyrics), scrubber, transport,
//  and the queue sheet. Styled after Apple Music; the control clusters use
//  Liquid Glass on iOS 26 (via the Glass.swift wrappers).
//

import SwiftUI

struct NowPlayingView: View {
    @Environment(Player.self) private var player
    @Environment(\.dismiss) private var dismiss

    @State private var showQueue = false
    @State private var showLyrics = false
    @State private var scrubTime: Double = 0
    @State private var isScrubbing = false

    var body: some View {
        Group {
            if let track = player.current {
                content(for: track)
            } else {
                // Queue was cleared while the player was open.
                Color.clear.onAppear { dismiss() }
            }
        }
    }

    // MARK: Layout

    private func content(for track: Track) -> some View {
        ZStack {
            NowPlayingBackground(track: track)

            VStack(spacing: 0) {
                grabber
                artworkArea(for: track)
                metadata(for: track)
                scrubber
                transport
                bottomBar
                    .padding(.top, 8)
                Spacer(minLength: 12)
            }
            .padding(.horizontal, 24)
        }
        .sheet(isPresented: $showQueue) {
            QueueView()
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    /// Swipe-down/tap grabber that closes the player.
    private var grabber: some View {
        Capsule()
            .fill(.secondary.opacity(0.5))
            .frame(width: 36, height: 5)
            .padding(.top, 10)
            .padding(.bottom, 18)
            .contentShape(Rectangle())
            .onTapGesture { dismiss() }
            .gesture(
                DragGesture(minimumDistance: 10)
                    .onEnded { value in
                        if value.translation.height > 50 { dismiss() }
                    }
            )
    }

    /// Artwork by default; the synced-lyrics panel takes its place on toggle.
    @ViewBuilder
    private func artworkArea(for track: Track) -> some View {
        ZStack {
            ArtworkView(url: track.artwork, fallbackURL: track.artworkAlt, cornerRadius: 12)
                .aspectRatio(1, contentMode: .fit)
                .shadow(color: .black.opacity(0.35), radius: 20, y: 10)

            if showLyrics {
                LyricsView()
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .transition(.opacity.combined(with: .scale(scale: 0.96)))
            }
        }
        .frame(maxWidth: .infinity)
        .aspectRatio(1, contentMode: .fit)
        .padding(.bottom, 24)
        .animation(.easeInOut(duration: 0.25), value: showLyrics)
    }

    private func metadata(for track: Track) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(track.title)
                    .font(.title3.weight(.semibold))
                    .lineLimit(1)
                    .foregroundStyle(.white)
                Text(track.artistLine)
                    .font(.subheadline)
                    .lineLimit(1)
                    .foregroundStyle(.white.opacity(0.7))
            }
            Spacer(minLength: 8)
            if !showLyrics {
                // Peek the first line next to the title when lyrics exist.
                if let next = player.lyrics?.displayLine(atMs: Int(player.currentTime * 1000)) {
                    Text(next.text)
                        .font(.footnote)
                        .foregroundStyle(.white.opacity(0.55))
                        .lineLimit(1)
                        .frame(maxWidth: 90, alignment: .trailing)
                }
            }
        }
        .padding(.bottom, 14)
    }

    private var scrubber: some View {
        VStack(spacing: 4) {
            Slider(
                value: Binding(
                    get: { isScrubbing ? scrubTime : player.currentTime },
                    set: { scrubTime = $0 }
                ),
                in: 0...max(player.duration, 1)
            ) { editing in
                isScrubbing = editing
                if !editing { player.seek(to: scrubTime) }
            }
            .tint(.white)

            HStack {
                Text(formatClock(isScrubbing ? scrubTime : player.currentTime))
                Spacer()
                Text("-" + formatClock(max(player.duration - (isScrubbing ? scrubTime : player.currentTime), 0)))
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(.white.opacity(0.6))
        }
        .padding(.bottom, 18)
    }

    private var transport: some View {
        HStack(spacing: 44) {
            Button {
                player.previous()
            } label: {
                Image(systemName: "backward.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(.white)
                    .frame(width: 56, height: 56)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .opacity(player.hasPrevious ? 1 : 0.35)

            Button {
                player.togglePlayPause()
            } label: {
                ZStack {
                    Circle()
                        .fill(.white.opacity(0.14))
                    if player.isBuffering {
                        ProgressView()
                            .tint(.white)
                            .controlSize(.large)
                    } else {
                        Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                            .font(.system(size: 30))
                            .foregroundStyle(.white)
                            .offset(x: player.isPlaying ? 0 : 2)  // optical centering
                    }
                }
                .frame(width: 68, height: 68)
            }
            .buttonStyle(.plain)

            Button {
                player.next()
            } label: {
                Image(systemName: "forward.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(.white)
                    .frame(width: 56, height: 56)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .opacity(player.hasNext ? 1 : 0.35)
        }
        .padding(.bottom, 22)
    }

    private var bottomBar: some View {
        HStack(spacing: 0) {
            // Lyrics toggle
            Button {
                withAnimation { showLyrics.toggle() }
            } label: {
                Image(systemName: showLyrics ? "quote.opening.inverted" : "quote.opening")
                    .font(.title3)
                    .foregroundStyle(showLyrics ? Color.accentColor : .white)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .disabled(player.lyrics == nil && !player.lyricsLoading)

            // Shuffle + repeat live in the middle on iOS; Apple Music keeps
            // AirPlay here — we surface shuffle/repeat, which this app owns.
            HStack(spacing: 28) {
                Button {
                    player.shuffle.toggle()
                } label: {
                    Image(systemName: "shuffle")
                        .font(.title3)
                        .foregroundStyle(player.shuffle ? Color.accentColor : .white.opacity(0.8))
                }
                .buttonStyle(.plain)

                Button {
                    switch player.repeatMode {
                    case .off: player.repeatMode = .all
                    case .all: player.repeatMode = .one
                    case .one: player.repeatMode = .off
                    }
                } label: {
                    Image(systemName: player.repeatMode == .one ? "repeat.1" : "repeat")
                        .font(.title3)
                        .foregroundStyle(player.repeatMode == .off ? .white.opacity(0.8) : Color.accentColor)
                }
                .buttonStyle(.plain)
            }
            .frame(maxWidth: .infinity)

            // Queue
            Button {
                showQueue = true
            } label: {
                Image(systemName: "list.bullet")
                    .font(.title3)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
        }
    }
}

/// Blurred artwork (or a dark gradient) filling the whole player.
private struct NowPlayingBackground: View {
    let track: Track

    var body: some View {
        ZStack {
            if let urlString = track.artwork ?? track.artworkAlt, let url = URL(string: urlString) {
                AsyncImage(url: url) { phase in
                    if case .success(let image) = phase {
                        image
                            .resizable()
                            .scaledToFill()
                    } else {
                        gradient
                    }
                }
                .blur(radius: 60)
                .scaleEffect(1.35)
            } else {
                gradient
            }

            Color.black.opacity(0.45)
        }
        .ignoresSafeArea()
    }

    private var gradient: some View {
        LinearGradient(
            colors: [Color(red: 0.29, green: 0.11, blue: 0.16), .black],
            startPoint: .top,
            endPoint: .bottom
        )
    }
}
