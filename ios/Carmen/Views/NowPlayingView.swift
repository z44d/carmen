//
//  NowPlayingView.swift
//  Carmen — the full player (Material 3 clone of the Android player
//  screen, V4 default design).
//
//  Mounted by RootView as an overlay that slides up from the mini bar
//  (`Player.expansion` drives the offset; dragging tracks the finger —
//  that contract lives in RootView and must not change).
//
//  Anatomy copied from Android's `PlayerControlsContent` (V4): big square
//  artwork (r16, swipe to skip), a SpaceBetween metadata row whose right
//  side is the three 44pt chip actions (Share / Like / More), a standard
//  Material slider with elapsed/total time labels, and the cinematic
//  transport row — small shuffle + large previous chips flowing into an
//  88pt play/pause (corner breathing 28↔44 with playback) and out the
//  other side through next + repeat. Panels (Lyrics / Queue / Related)
//  still take over the content area exactly like before; the collapse
//  gesture lives in the metadata row and the artwork's vertical drag.
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
    @Environment(LibraryStore.self) private var library

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

    /// Android V4 column: thumbnail in the free space, then title/actions,
    /// slider + times, transport, and a 30pt tail.
    private func playerBody(for track: Track) -> some View {
        VStack(spacing: 0) {
            artworkArea(for: track)
            metadata(for: track)
            scrubber
            transport
            Spacer(minLength: 30)
        }
    }

    /// Motion video when the track has it, the static cover otherwise.
    /// Square, r16 (Android's ThumbnailCornerRadius default), swipe left /
    /// right skips tracks, vertical drag collapses the player.
    @ViewBuilder
    private func artworkArea(for track: Track) -> some View {
        let expansion = player.expansion
        Group {
            if let motionURL = player.motionArtworkURL {
                MotionArtworkView(
                    urlString: motionURL,
                    artworkID: "carmen." + (track.album?.id ?? track.videoId),
                    staticURL: track.artwork,
                    staticFallbackURL: track.artworkAlt
                )
            } else {
                ArtworkView(url: track.artwork, fallbackURL: track.artworkAlt, cornerRadius: 16)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .frame(maxWidth: .infinity)
        .clipShape(M3Shape.sheet)
        .shadow(color: m3.scrim.opacity(0.35), radius: 22, y: 12)
        .scaleEffect(0.5 + 0.5 * expansion)
        .opacity(0.35 + 0.65 * expansion)
        .frame(maxHeight: 330)
        .padding(.bottom, 24)
        .gesture(skipSwipe)
        .simultaneousGesture(collapseGesture)
    }

    /// Android's swipe-thumbnail: flick left = next, right = previous.
    private var skipSwipe: some Gesture {
        DragGesture(minimumDistance: 40)
            .onEnded { value in
                if abs(value.translation.width) > abs(value.translation.height) {
                    if value.translation.width < -60 {
                        player.next()
                    } else if value.translation.width > 60 {
                        player.previous()
                    }
                }
            }
    }

    /// Collapses the player on a downward drag, tracking the finger live.
    private var collapseGesture: some Gesture {
        DragGesture(minimumDistance: 24)
            .onChanged { value in
                guard abs(value.translation.height) > abs(value.translation.width) else { return }
                let progress = 1 - value.translation.height / Self.dragRange
                player.expansion = max(0, min(1, progress))
            }
            .onEnded { value in
                guard abs(value.translation.height) > abs(value.translation.width) else { return }
                if value.translation.height > 120 || value.predictedEndTranslation.height > 400 {
                    player.closePlayer()
                } else {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                        player.expansion = 1
                    }
                }
            }
    }

    /// SpaceBetween row: title + artist on the left, the three 44pt chip
    /// actions (Share / Like / More) on the right — `PlayerTopActions` V4.
    private func metadata(for track: Track) -> some View {
        let liked = library.isFavorite(track.videoId)
        return HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(track.title)
                        .font(.m3TitleLarge)
                        .foregroundStyle(m3.onSurface)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    if track.isExplicit { ExplicitBadge() }
                }
                Text(track.artistLine)
                    .font(.m3TitleMedium)
                    .foregroundStyle(m3.onSurfaceVariant)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .gesture(collapseGesture)

            HStack(spacing: 10) {
                ShareLink(item: "https://carmen.z44d.com/?song=" + track.videoId) {
                    Image(systemName: "square.and.arrow.up")
                        .font(.system(size: 17, weight: .medium))
                        .frame(width: 44, height: 44)
                        .background(m3.onSurface.opacity(0.12), in: M3Shape.dialog)
                }
                .foregroundStyle(m3.onSurface)
                .accessibilityLabel("Share")

                Button {
                    library.toggleFavorite(track)
                } label: {
                    Image(systemName: liked ? "heart.fill" : "heart")
                        .font(.system(size: 17, weight: .medium))
                        .frame(width: 44, height: 44)
                        .background(
                            liked ? m3.error.opacity(0.25) : m3.onSurface.opacity(0.12),
                            in: M3Shape.dialog
                        )
                        .foregroundStyle(liked ? m3.error : m3.onSurface)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(liked ? "Remove Favorite" : "Favorite")

                Menu {
                    TrackSheetMenu(track: track)
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(width: 44, height: 44)
                        .background(m3.onSurface.opacity(0.12), in: M3Shape.dialog)
                }
                .foregroundStyle(m3.onSurface)
                .accessibilityLabel("More options")
            }
        }
        .padding(.horizontal, 32)
        .padding(.bottom, 12)
    }

    /// Material standard slider: faint track, ink fill, round thumb —
    /// seek commits on release (Android's Standard SliderStyle).
    private var scrubber: some View {
        VStack(spacing: 4) {
            GeometryReader { proxy in
                let width = max(proxy.size.width, 1)
                let total = max(player.duration, 1)
                let shown = isScrubbing ? scrubTime : player.currentTime
                let fraction = min(max(shown / total, 0), 1)
                let playable = player.duration > 0

                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(m3.onSurface.opacity(0.24))
                    Capsule()
                        .fill(m3.onSurface)
                        .frame(width: max(0, width * fraction))
                    Circle()
                        .fill(m3.onSurface)
                        .frame(width: 14, height: 14)
                        .offset(x: max(0, min(width - 14, width * fraction - 7)))
                }
                .frame(height: 20)
                .contentShape(Rectangle())
                .opacity(playable ? 1 : 0.4)
                .gesture(scrubGesture(width: width))
            }
            .frame(height: 20)

            HStack {
                Text(formatClock(isScrubbing ? scrubTime : player.currentTime))
                Spacer()
                Text(formatClock(max(player.duration, 0)))
            }
            .font(.m3LabelMedium.monospacedDigit())
            .foregroundStyle(m3.onSurface)
        }
        .padding(.horizontal, 32)
        .padding(.bottom, 12)
    }

    private func scrubGesture(width: CGFloat) -> some Gesture {
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
    }

    /// Android V4 transport: [shuffle small · prev large] ⇄ 88pt cinematic
    /// play (corner breathes 28↔44 with playback) ⇄ [next large · repeat
    /// small], all as tinted Surface chips.
    private var transport: some View {
        HStack(spacing: 0) {
            HStack(spacing: 12) {
                controlChip(
                    systemImage: "shuffle",
                    size: 46, icon: 22, corner: 16,
                    tint: player.shuffle ? m3.onSurface.opacity(0.2) : m3.onSurface.opacity(0.08)
                ) {
                    player.shuffle.toggle()
                }
                .foregroundStyle(player.shuffle ? m3.onSurface : m3.onSurface.opacity(0.55))

                controlChip(
                    systemImage: "backward.end.fill",
                    size: 56, icon: 28, corner: 18
                ) {
                    player.previous()
                }
                .foregroundStyle(m3.onSurface)
                .opacity(player.hasPrevious ? 1 : 0.4)
                .disabled(!player.hasPrevious)
            }
            .frame(maxWidth: .infinity, alignment: .trailing)

            Button {
                player.togglePlayPause()
            } label: {
                ZStack {
                    if player.isBuffering {
                        ProgressView()
                            .controlSize(.large)
                            .tint(m3.background)
                    } else {
                        Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                            .font(.system(size: 30, weight: .semibold))
                            .foregroundStyle(m3.background)
                            .offset(x: player.isPlaying ? 0 : 2)  // optical centering
                    }
                }
                .frame(width: 88, height: 88)
                .background(
                    m3.onSurface,
                    in: RoundedRectangle(cornerRadius: player.isPlaying ? 28 : 44, style: .continuous)
                )
                .animation(.spring(response: 0.25, dampingFraction: 0.7), value: player.isPlaying)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 20)
            .accessibilityLabel(player.isPlaying ? "Pause" : "Play")

            HStack(spacing: 12) {
                controlChip(
                    systemImage: "forward.end.fill",
                    size: 56, icon: 28, corner: 18
                ) {
                    player.next()
                }
                .foregroundStyle(m3.onSurface)
                .opacity(player.hasNext ? 1 : 0.4)
                .disabled(!player.hasNext)

                controlChip(
                    systemImage: player.repeatMode == .one ? "repeat.1" : "repeat",
                    size: 46, icon: 22, corner: 16,
                    tint: player.repeatMode == .off
                        ? m3.onSurface.opacity(0.08)
                        : m3.onSurface.opacity(0.2)
                ) {
                    switch player.repeatMode {
                    case .off: player.repeatMode = .all
                    case .all: player.repeatMode = .one
                    case .one: player.repeatMode = .off
                    }
                }
                .foregroundStyle(
                    player.repeatMode == .off
                        ? m3.onSurface.opacity(0.55) : m3.onSurface
                )
                .accessibilityLabel("Repeat " + player.repeatMode.label)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 32)
        .padding(.bottom, 14)
    }

    /// One tinted chip button of the transport row (Android's Surface chips).
    private func controlChip(
        systemImage: String,
        size: CGFloat,
        icon: CGFloat,
        corner: CGFloat,
        tint: Color? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: icon, weight: .medium))
                .frame(width: size, height: size)
                .background(
                    tint ?? m3.onSurface.opacity(0.15),
                    in: RoundedRectangle(cornerRadius: corner, style: .continuous)
                )
        }
        .buttonStyle(.plain)
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
