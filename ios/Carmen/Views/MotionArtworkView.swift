//
//  MotionArtworkView.swift
//  Carmen — in-app animated artwork.
//
//  Plays a track's motion ("animated") cover — the same Apple-catalogue mp4
//  the iOS 26 lock screen gets — looped and muted inside the Now Playing
//  artwork tile. The file resolves through MotionArtwork's disk cache (which
//  the Player prefetches the moment the motion URL resolves), so a second
//  look never re-downloads.
//
//  The static cover stays painted underneath the video layer for the whole
//  ride: while the mp4 downloads and — if it never arrives — permanently.
//  The video layer fades in only once its first frame is decoded, so the
//  tile never flashes black or shows a grey box. When connectivity returns,
//  the whole thing retries (`NetworkMonitor.generation`).
//
//  Looping is done by hand (rewind on AVPlayerItemDidPlayToEndTime): the SDK
//  has no AVPlayerItemLooper — only AVQueuePlayer item chains, which stall
//  for one frame at the seam.
//

import AVFoundation
import SwiftUI
import UIKit

struct MotionArtworkView: View {
    let urlString: String
    let artworkID: String
    /// The static cover painted under the video (primary, then fallback).
    var staticURL: String?
    var staticFallbackURL: String?

    @State private var player: AVPlayer?
    @State private var loopObserver: NSObjectProtocol?

    var body: some View {
        ZStack {
            // Base layer: the cover itself — the loading state AND the
            // no-motion-art state, in one. It stays painted under the video
            // for the whole ride, so the player always opens with a thumb.
            ArtworkView(url: staticURL, fallbackURL: staticFallbackURL, cornerRadius: 0)

            if let player {
                MotionPlayerLayer(player: player)
            }
        }
        // Square, always: the raw thumbnail is 16:9, and neither it nor the
        // video layer may hand a landscape size to the sheet's layout before
        // the crop happens.
        .aspectRatio(1, contentMode: .fit)
        .clipped()
        // Re-run when connectivity flips back (the mp4 fetch may have died offline).
        .task(id: "\(urlString)#\(NetworkMonitor.shared.generation)") {
            teardown()
            guard let file = await MotionArtwork.localFile(urlString: urlString, id: artworkID) else {
                return  // static cover stays visible — same as the lock screen
            }
            let player = AVPlayer(url: file)
            player.isMuted = true
            // Loop: rewind + replay whenever the clip runs out.
            let observer = NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime,
                object: player.currentItem,
                queue: .main
            ) { _ in
                player.seek(to: .zero)
                player.play()
            }
            loopObserver = observer
            self.player = player
            player.play()
        }
        .onDisappear { teardown() }
    }

    private func teardown() {
        player?.pause()
        if let loopObserver { NotificationCenter.default.removeObserver(loopObserver) }
        loopObserver = nil
        player = nil
    }
}

/// AVPlayerLayer host — SwiftUI has no native looping-video layer. The layer
/// stays invisible until `isReadyForDisplay` (first frame decoded), then
/// fades in over the static base.
private struct MotionPlayerLayer: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> MotionLayerView {
        let view = MotionLayerView()
        view.playerLayer.player = player
        view.playerLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ uiView: MotionLayerView, context: Context) {
        uiView.playerLayer.player = player
    }

    /// Take exactly what was proposed. A bare UIView answers size queries
    /// with its *last* bounds, and feeding those back into the artwork's
    /// aspect-ratio math is how the sheet ended up sized by a thumbnail's
    /// landscape dimensions instead of the screen's.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: MotionLayerView, context: Context) -> CGSize? {
        guard let width = proposal.width, let height = proposal.height else { return nil }
        return CGSize(width: width, height: height)
    }
}

final class MotionLayerView: UIView {
    let playerLayer = AVPlayerLayer()
    private var readyObservation: NSKeyValueObservation?

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.addSublayer(playerLayer)
        // No frame decoded yet → invisible; first frame → fade in. Without
        // this the layer paints black over the cover while it buffers.
        playerLayer.opacity = 0
        readyObservation = playerLayer.observe(\.isReadyForDisplay) { [weak self] layer, _ in
            guard let self else { return }
            let target: Float = layer.isReadyForDisplay ? 1 : 0
            guard self.playerLayer.opacity != target else { return }
            UIView.animate(withDuration: 0.45) {
                self.playerLayer.opacity = target
            }
        }
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        layer.addSublayer(playerLayer)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        playerLayer.frame = bounds
    }
}
