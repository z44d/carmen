//
//  NowPlayingView.swift
//  Carmen — the full player (Material 3 clone of the Android player screen).
//
//  Mounted by RootView as an overlay that slides up from the mini bar
//  (`Player.expansion` drives the offset; dragging the header tracks the
//  finger back down — that contract lives in RootView and must not change).
//  Inside: the ambient blurred-cover backdrop washed with the artwork's own
//  colour (adaptive accent), motion artwork that grows with the sheet,
//  centered metadata, a capsule scrubber, transport with shuffle/repeat, and
//  a bottom action bar (Lyrics / Queue / Related / Download) whose toggles
//  swap the content area for a panel takeover — compact now-playing card +
//  thin progress rail + the panel body, exactly like the web client's panel
//  takeover, with dismiss one tap away.
//
//  The player is always a dark surface: the content is re-themed with dark
//  Material roles and evaluated as dark regardless of system appearance.
//

import SwiftUI

enum PlayerPanel: String, CaseIterable, Identifiable {
    case lyrics, queue, related

    var id: String { rawValue }

    var title: String {
        switch self {
        case .lyrics: return "Lyrics"
        case .queue: return "Queue"
        case .related: return "Related"
        }
    }

    var symbol: String {
        switch self {
        case .lyrics: return "text.quote"
        case .queue: return "list.bullet"
        case .related: return "sparkles"
        }
    }
}

struct NowPlayingView: View {
    @Environment(Player.self) private var player
    @Environment(\.m3) private var m3

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
            // A panel the player asked for (openPlayer(panel:)) — open
            // straight into it once.
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
                    thinProgressBar
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
        // The backdrop is always dark — re-derive the Material roles for the
        // player subtree (m3Theme reads the scheme set right below it).
        .m3Theme()
        .environment(\.colorScheme, .dark)
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
                .fill(m3.onSurfaceVariant.opacity(0.5))
                .frame(width: 36, height: 5)
            HStack {
                Button {
                    player.closePlayer()
                } label: {
                    Image(systemName: "chevron.down")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(m3.onSurfaceVariant)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close Player")

                Spacer()
                Text("NOW PLAYING")
                    .font(.m3LabelSmall)
                    .tracking(1.2)
                    .foregroundStyle(m3.onSurfaceVariant)
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
        .clipShape(M3Shape.card)
        .shadow(color: m3.scrim.opacity(0.35), radius: 22, y: 12)
        .scaleEffect(0.5 + 0.5 * expansion)
        .opacity(0.35 + 0.65 * expansion)
        .frame(maxHeight: 330)
        .padding(.bottom, 16)
    }

    private func metadata(for track: Track) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(spacing: 4) {
                HStack(spacing: 5) {
                    Text(track.title)
                        .font(.m3TitleLarge)
                        .foregroundStyle(m3.onSurface)
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                        .multilineTextAlignment(.center)
                    if track.isExplicit { ExplicitBadge() }
                }
                Text(track.artistLine)
                    .font(.m3BodyLarge)
                    .foregroundStyle(m3.onSurfaceVariant)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
            .frame(maxWidth: .infinity, alignment: .center)

            FavoriteButton(track: track)
        }
        .padding(.bottom, 14)
    }

    /// Capsule scrubber: surface-highest track, primary fill up to the
    /// playhead, circular thumb — seek on release.
    private var scrubber: some View {
        VStack(spacing: 6) {
            GeometryReader { proxy in
                let width = max(proxy.size.width, 1)
                let total = max(player.duration, 1)
                let shown = isScrubbing ? scrubTime : player.currentTime
                let fraction = min(max(shown / total, 0), 1)
                let playable = player.duration > 0

                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(m3.surfaceContainerHighest)
                    Capsule()
                        .fill(m3.primary)
                        .frame(width: max(0, width * fraction))
                    Circle()
                        .fill(m3.primary)
                        .frame(width: 14, height: 14)
                        .offset(x: max(0, min(width - 14, width * fraction - 7)))
                }
                .frame(height: 20)
                .contentShape(Rectangle())
                .opacity(playable ? 1 : 0.4)
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            // No duration yet → the track is parked, not seekable.
                            guard player.duration > 0 else { return }
                            isScrubbing = true
                            scrubTime = min(max(value.location.x / width, 0), 1) * player.duration
                        }
                        .onEnded { _ in
                            guard isScrubbing else { return }
                            isScrubbing = false
                            player.seek(to: scrubTime)
                        }
                )
            }
            .frame(height: 20)

            HStack {
                Text(formatClock(isScrubbing ? scrubTime : player.currentTime))
                Spacer()
                Text(
                    "-" + formatClock(
                        max(player.duration - (isScrubbing ? scrubTime : player.currentTime), 0)
                    )
                )
            }
            .font(.m3LabelSmall.monospacedDigit())
            .foregroundStyle(m3.onSurfaceVariant)
        }
        .padding(.bottom, 14)
    }

    /// shuffle · previous · play · next · repeat — evenly spaced, the play
    /// circle the only filled surface.
    private var transport: some View {
        HStack(spacing: 0) {
            Button {
                player.shuffle.toggle()
            } label: {
                Image(systemName: "shuffle")
                    .font(.system(size: 17, weight: .medium))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(M3IconButtonStyle(foreground: player.shuffle ? m3.primary : m3.onSurfaceVariant))

            Button {
                player.previous()
            } label: {
                Image(systemName: "backward.fill")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(m3.onSurface)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(M3IconButtonStyle(foreground: m3.onSurface))
            .opacity(player.hasPrevious ? 1 : 0.35)

            Button {
                player.togglePlayPause()
            } label: {
                ZStack {
                    Circle()
                        .fill(m3.primary)
                    if player.isBuffering {
                        ProgressView()
                            .controlSize(.large)
                            .tint(m3.onPrimary)
                    } else {
                        Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                            .font(.system(size: 26, weight: .semibold))
                            .foregroundStyle(m3.onPrimary)
                            .offset(x: player.isPlaying ? 0 : 2)  // optical centering
                    }
                }
                .frame(width: 64, height: 64)
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(player.isPlaying ? "Pause" : "Play")

            Button {
                player.next()
            } label: {
                Image(systemName: "forward.fill")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(m3.onSurface)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(M3IconButtonStyle(foreground: m3.onSurface))
            .opacity(player.hasNext ? 1 : 0.35)

            Button {
                switch player.repeatMode {
                case .off: player.repeatMode = .all
                case .all: player.repeatMode = .one
                case .one: player.repeatMode = .off
                }
            } label: {
                Image(systemName: player.repeatMode == .one ? "repeat.1" : "repeat")
                    .font(.system(size: 17, weight: .medium))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(
                M3IconButtonStyle(
                    foreground: player.repeatMode == .off ? m3.onSurfaceVariant : m3.primary
                )
            )
            .accessibilityLabel("Repeat \(player.repeatMode.label)")
        }
        .padding(.bottom, 14)
    }

    /// Panel mode keeps the playhead one glance away: a 3pt progress rail
    /// under the compact card (seeking stays in the artwork view).
    private var thinProgressBar: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(m3.surfaceContainerHighest)
                Capsule()
                    .fill(m3.primary)
                    .frame(width: max(0, proxy.size.width * player.progress))
            }
        }
        .frame(height: 3)
        .padding(.horizontal, 20)
        .padding(.bottom, 12)
    }

    // MARK: Panels

    /// The bottom action bar — Lyrics / Queue / Related toggles plus the
    /// download control for the current track. Tapping the active toggle
    /// returns to the artwork view (frontend parity).
    private func actionBar(for track: Track) -> some View {
        HStack(spacing: 0) {
            ForEach(PlayerPanel.allCases) { panel in
                Button {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                        activePanel = activePanel == panel ? nil : panel
                    }
                } label: {
                    VStack(spacing: 3) {
                        Image(systemName: panel.symbol)
                            .font(.system(size: 16, weight: .medium))
                            .frame(height: 30)
                        Text(panel.title)
                            .font(.m3LabelSmall)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    .foregroundStyle(activePanel == panel ? m3.primary : m3.onSurfaceVariant)
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(panel.title)
            }

            VStack(spacing: 3) {
                DownloadButton(track: track, diameter: 18)
                    .frame(height: 30)
                Text("Download")
                    .font(.m3LabelSmall)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .foregroundStyle(m3.onSurfaceVariant)
            }
            .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(m3.surfaceContainerHigh, in: M3Shape.sheet)
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
    }

    /// Compact now-playing card above an open panel (the takeover header).
    private func compactCard(for track: Track) -> some View {
        HStack(spacing: 12) {
            ArtworkView(url: track.artwork, fallbackURL: track.artworkAlt, cornerRadius: 8)
                .frame(width: 44, height: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(track.title)
                    .font(.m3BodyMedium.weight(.semibold))
                    .foregroundStyle(m3.onSurface)
                    .lineLimit(1)
                Text(track.artistLine)
                    .font(.m3BodySmall)
                    .foregroundStyle(m3.onSurfaceVariant)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            FavoriteButton(track: track)
            Button {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                    activePanel = nil
                }
            } label: {
                Image(systemName: "chevron.down")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(m3.onSurfaceVariant)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back to Player")
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 8)
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
                        .init(color: m3.scrim.opacity(0.35), location: 0.35),
                        .init(color: m3.scrim.opacity(0.6), location: 1),
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
        case .queue: QueuePanel()
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
