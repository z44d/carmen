//
//  MotionArtworkView.swift
//  Carmen — in-app animated artwork.
//
//  Plays a track's motion ("animated") cover — the same Apple-catalogue mp4
//  the iOS 26 lock screen gets — looped and muted inside the Now Playing
//  artwork tile. The file resolves through MotionArtwork's disk cache, so a
//  second look never re-downloads.
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

    @State private var player: AVPlayer?
    @State private var loopObserver: NSObjectProtocol?
    @State private var failed = false

    var body: some View {
        ZStack {
            if let player {
                MotionPlayerLayer(player: player)
            } else if failed {
                Rectangle().fill(Color(.secondarySystemFill))
                Image(systemName: "music.note")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(.secondary)
            } else {
                // First-frame stand-in while the mp4 downloads.
                Rectangle().fill(Color(.secondarySystemFill))
                ProgressView().controlSize(.small)
            }
        }
        .task(id: urlString) {
            teardown()
            guard let file = await MotionArtwork.localFile(urlString: urlString, id: artworkID) else {
                failed = true
                return
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

/// AVPlayerLayer host — SwiftUI has no native looping-video layer.
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
}

final class MotionLayerView: UIView {
    let playerLayer = AVPlayerLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.addSublayer(playerLayer)
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
