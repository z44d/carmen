//
//  NowPlayingView.swift
//  Carmen — the full player.
//
//  Mounted by RootView as an overlay that slides up from the mini bar
//  (`Player.expansion` drives the offset; dragging the header tracks the
//  finger back down). Inside: adaptive artwork (motion video when the track
//  has any, growing with the sheet), metadata with a favorite heart, the
//  scrubber, transport with shuffle/repeat, and the Lyrics / Related
//  action pill that swaps the content area for a panel with a compact card +
//  playing bar above it — the web client's panel takeover, with the scrubber
//  and transport always one glance away. (The queue lives in its own tab,
//  next to Search, like the frontend's drawer.)
//
//  Theming is ambient: the blurred cover fills the background and, when
//  Settings → Appearance → Adaptive Accent is on, the cover's own colour
//  washes the whole player so the surface belongs to the record. Panels
//  stay transparent over that wash instead of masking it with a material.
//  Liquid Glass via the Glass.swift wrappers; the player is always a dark
//  surface, so the content is evaluated as dark regardless of system
//  appearance.
//

import SwiftUI

enum PlayerPanel: String, CaseIterable, Identifiable {
    case lyrics, related

    var id: String { rawValue }

    var title: String {
        switch self {
        case .lyrics: return "Lyrics"
        case .related: return "Related"
        }
    }

    var symbol: String {
        switch self {
        case .lyrics: return "text.quote"
        case .related: return "sparkles"
        }
    }
}

struct NowPlayingView: View {
    @Environment(Player.self) private var player

    @State private var activePanel: PlayerPanel?
    @State private var scrubTime: Double = 0
    @State private var isScrubbing = false

    /// Drag travel mapped onto a full expansion — must match RootView's
    /// 1000pt offset travel so the sheet tracks the finger 1:1.
    private static let dragRange: CGFloat = 1000

    var body: some View {
        Group {
            if let track = player.current {
                content(for: track)
            } else {
                // Queue was cleared while the player was open (stop closes it).
                Color.clear
            }
        }
        .onAppear {
            // A panel the player asked for (mini-bar queue button, Related
            // tap while playing) — open straight into it once.
            if let panel = player.pendingPanel {
                activePanel = panel
                player.pendingPanel = nil
            }
        }
    }

    // MARK: Layout

    private func content(for track: Track) -> some View {
        ZStack {
            NowPlayingBackground(track: track, tint: player.adaptiveColor)

            VStack(spacing: 0) {
                header

                if let panel = activePanel {
                    compactCard(for: track)
                    playingBar
                    panelBody(panel)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                } else {
                    playerBody(for: track)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .transition(.opacity)
                }

                actionBar(for: track)
            }
        }
        .environment(\.colorScheme, .dark)  // the backdrop is always dark
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: activePanel)
    }

    private func playerBody(for track: Track) -> some View {
        VStack(spacing: 0) {
            artworkArea(for: track)
            metadata(for: track)
            scrubber
            transport
            Spacer(minLength: 8)
        }
        .padding(.horizontal, 24)
    }

    /// Grabber + eyebrow row — also the drag zone that collapses the player.
    private var header: some View {
        VStack(spacing: 6) {
            Capsule()
                .fill(.secondary.opacity(0.5))
                .frame(width: 36, height: 5)
            HStack {
                Button {
                    player.closePlayer()
                } label: {
                    Image(systemName: "chevron.down")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close Player")

                Spacer()
                Text("NOW PLAYING")
                    .font(.caption2.weight(.semibold))
                    .tracking(1.2)
                    .foregroundStyle(.secondary)
                Spacer()

                Color.clear.frame(width: 32, height: 32)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
        .padding(.bottom, 10)
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 10)
                .onChanged { value in
                    // Track the finger — RootView's offset reads this live.
                    let progress = 1 - value.translation.height / Self.dragRange
                    player.expansion = max(0, min(1, progress))
                }
                .onEnded { value in
                    if value.translation.height > 120 || value.predictedEndTranslation.height > 400 {
                        player.closePlayer()
                    } else {
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                            player.expansion = 1
                        }
                    }
                }
        )
    }

    /// Motion video when the track has it, the static cover otherwise — both
    /// growing with the sheet so the player feels like it left the mini bar.
    @ViewBuilder
    private func artworkArea(for track: Track) -> some View {
        let expansion = player.expansion
        Group {
            if let motionURL = player.motionArtworkURL {
                MotionArtworkView(
                    urlString: motionURL,
                    artworkID: "carmen.\(track.album?.id ?? track.videoId)",
                    staticURL: track.artwork,
                    staticFallbackURL: track.artworkAlt
                )
            } else {
                ArtworkView(url: track.artwork, fallbackURL: track.artworkAlt, cornerRadius: 12)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .shadow(color: .black.opacity(0.35), radius: 22, y: 12)
        .scaleEffect(0.5 + 0.5 * expansion)
        .opacity(0.35 + 0.65 * expansion)
        .frame(maxHeight: 420)
        .padding(.bottom, 20)
    }

    private func metadata(for track: Track) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    Text(track.title)
                        .font(.title3.weight(.semibold))
                        .lineLimit(1)
                        .foregroundStyle(.primary)
                    if track.isExplicit { ExplicitBadge() }
                }
                HStack(spacing: 4) {
                    Text(track.artistLine)
                        .font(.subheadline)
                        .lineLimit(1)
                        .foregroundStyle(.secondary)
                    if !track.albumName.isEmpty {
                        Text("·")
                            .foregroundStyle(.secondary)
                        Text(track.albumName)
                            .font(.subheadline)
                            .lineLimit(1)
                            .foregroundStyle(.secondary.opacity(0.8))
                    }
                }
            }
            Spacer(minLength: 8)
            FavoriteButton(track: track)
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
                Text(
                    "-" + formatClock(
                        max(player.duration - (isScrubbing ? scrubTime : player.currentTime), 0)
                    )
                )
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
        }
        .padding(.bottom, 18)
    }

    /// shuffle · previous · play · next · repeat — Apple Music's order.
    private var transport: some View {
        HStack(spacing: 0) {
            Button {
                player.shuffle.toggle()
            } label: {
                Image(systemName: "shuffle")
                    .font(.title3)
                    .foregroundStyle(player.shuffle ? Color.carmen : .secondary)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)

            Button {
                player.previous()
            } label: {
                Image(systemName: "backward.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .opacity(player.hasPrevious ? 1 : 0.35)

            Button {
                player.togglePlayPause()
            } label: {
                ZStack {
                    Circle()
                        .fill(.primary.opacity(0.12))
                    if player.isBuffering {
                        ProgressView()
                            .controlSize(.large)
                    } else {
                        Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                            .font(.system(size: 28))
                            .foregroundStyle(.primary)
                            .offset(x: player.isPlaying ? 0 : 2)  // optical centering
                    }
                }
                .frame(width: 64, height: 64)
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)

            Button {
                player.next()
            } label: {
                Image(systemName: "forward.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .opacity(player.hasNext ? 1 : 0.35)

            Button {
                switch player.repeatMode {
                case .off: player.repeatMode = .all
                case .all: player.repeatMode = .one
                case .one: player.repeatMode = .off
                }
            } label: {
                Image(systemName: player.repeatMode == .one ? "repeat.1" : "repeat")
                    .font(.title3)
                    .foregroundStyle(player.repeatMode == .off ? Color.secondary : Color.carmen)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
        }
        .padding(.bottom, 14)
    }

    /// Panel mode keeps the scrubber + transport alive under the compact
    /// card (queueing songs shouldn't stop you from skipping or seeking).
    private var playingBar: some View {
        VStack(spacing: 2) {
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

            HStack(spacing: 0) {
                Button {
                    player.previous()
                } label: {
                    Image(systemName: "backward.fill")
                        .font(.system(size: 20))
                        .foregroundStyle(.primary)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .opacity(player.hasPrevious ? 1 : 0.35)

                Button {
                    player.togglePlayPause()
                } label: {
                    ZStack {
                        Circle()
                            .fill(.primary.opacity(0.12))
                        if player.isBuffering {
                            ProgressView()
                                .controlSize(.regular)
                        } else {
                            Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                                .font(.system(size: 20))
                                .foregroundStyle(.primary)
                                .offset(x: player.isPlaying ? 0 : 1.5)
                        }
                    }
                    .frame(width: 44, height: 44)
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)

                Button {
                    player.next()
                } label: {
                    Image(systemName: "forward.fill")
                        .font(.system(size: 20))
                        .foregroundStyle(.primary)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .opacity(player.hasNext ? 1 : 0.35)
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 10)
    }

    // MARK: Panels

    /// The bottom pill — the mini bar's twin (same 56 pt height, same 16 pt
    /// radius, same inset): Lyrics / Related cells + the download control.
    /// Tapping the active cell returns to the artwork view (frontend parity).
    private func actionBar(for track: Track) -> some View {
        HStack(spacing: 0) {
            ForEach(PlayerPanel.allCases) { panel in
                Button {
                    withAnimation {
                        activePanel = activePanel == panel ? nil : panel
                    }
                } label: {
                    VStack(spacing: 2) {
                        Image(systemName: panel.symbol)
                            .font(.footnote)
                        Text(panel.title)
                            .font(.system(size: 10, weight: .medium))
                    }
                    .foregroundStyle(activePanel == panel ? Color.carmen : Color.secondary)
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }

            DownloadButton(track: track, diameter: 20)
                .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 12)
        .frame(height: 56)
        .glassCard(cornerRadius: 16)
        .padding(.horizontal, 8)
        .padding(.bottom, 6)
    }

    /// Compact now-playing card above an open panel (the takeover header).
    private func compactCard(for track: Track) -> some View {
        HStack(spacing: 12) {
            ArtworkView(url: track.artwork, fallbackURL: track.artworkAlt, cornerRadius: 6)
                .frame(width: 44, height: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(track.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .foregroundStyle(.primary)
                Text(track.artistLine)
                    .font(.caption)
                    .lineLimit(1)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            FavoriteButton(track: track)
            Button {
                withAnimation { activePanel = nil }
            } label: {
                Image(systemName: "chevron.down")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back to Player")
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 10)
    }

    /// Panels float over the ambient wash: a clear → black scrim dims the
    /// backdrop toward the list without ever masking the album theme with a
    /// material (the web client's translucent panel).
    private func panelBody(_ panel: PlayerPanel) -> some View {
        panelContent(panel)
            .scrollContentBackground(.hidden)
            .background(
                LinearGradient(
                    stops: [
                        .init(color: .clear, location: 0),
                        .init(color: .black.opacity(0.35), location: 0.35),
                        .init(color: .black.opacity(0.6), location: 1),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
    }

    @ViewBuilder
    private func panelContent(_ panel: PlayerPanel) -> some View {
        switch panel {
        case .lyrics: LyricsView()
        case .related: RelatedPanel()
        }
    }
}

/// Blurred artwork (or a dark gradient) filling the whole player, with the
/// cover's own colour washed over it — the ambient theme the frontend calls
/// "adaptive".
private struct NowPlayingBackground: View {
    let track: Track
    /// The playing cover's accent (nil = keep the default dark surface).
    var tint: Color?

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

            if let tint {
                // One hue for the whole player, following the artwork.
                tint.opacity(0.4)
            }
            Color.black.opacity(tint == nil ? 0.45 : 0.28)
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
