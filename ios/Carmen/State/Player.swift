//
//  Player.swift
//  Carmen — playback engine: owns the AVPlayer and the queue, and mirrors
//  both into the OS surfaces (Now Playing info, remote commands, the lyric
//  Live Activity) plus the lyrics state the Now Playing screen renders.
//

import AVFoundation
import Foundation
import MediaPlayer
import Observation
import SwiftUI
import UIKit

enum RepeatMode: String, CaseIterable, Sendable {
    case off, all, one

    var label: String {
        switch self {
        case .off: "Off"
        case .all: "All"
        case .one: "One"
        }
    }

    var symbol: String {
        repeatModeSymbol(self)
    }
}

private func repeatModeSymbol(_ mode: RepeatMode) -> String {
    switch mode {
    case .off: "repeat"
    case .all: "repeat"
    case .one: "repeat.1"
    }
}

@MainActor
@Observable
final class Player {
    static let shared = Player()

    // MARK: Published state

    private(set) var queue: [Track] = []
    private(set) var currentIndex: Int = 0
    private(set) var isPlaying = false
    private(set) var isBuffering = false
    private(set) var currentTime: Double = 0
    private(set) var duration: Double = 0
    private(set) var errorMessage: String?

    var shuffle: Bool {
        get { _shuffle }
        set {
            _shuffle = newValue
            UserDefaults.standard.set(newValue, forKey: Self.shuffleKey)
        }
    }

    var repeatMode: RepeatMode {
        get { RepeatMode(rawValue: _repeatModeRaw) ?? .off }
        set {
            _repeatModeRaw = newValue.rawValue
            UserDefaults.standard.set(newValue.rawValue, forKey: Self.repeatModeKey)
        }
    }

    /// Mount flag for the player overlay — presentation always goes through
    /// `openPlayer()` / `closePlayer()` so `expansion` never gets out of sync.
    private(set) var showNowPlaying = false
    /// 0 = collapsed on the mini bar, 1 = fully expanded. The drag gesture
    /// writes it directly so the sheet tracks the finger.
    var expansion: Double = 0

    // MARK: Lyrics

    private(set) var lyrics: Lyrics?
    private(set) var lyricsLoading = false
    /// `false` renders the unsynced plain-text view instead of timed lines.
    var syncedLyricsEnabled = true

    // MARK: Related songs (auto-continue + Home suggestions)

    /// `/browsing/related/{id}` for the current track — the player's Related
    /// tab, the auto-continue pool, and (first 10) the Home suggestion feed.
    private(set) var related: [Track] = []
    /// Which song `related` describes (nil while it never loaded).
    private(set) var relatedVideoId: String?
    private(set) var relatedLoading = false

    // MARK: Motion (animated) artwork

    /// Resolved motion-artwork mp4 for the current track (nil = none yet).
    private(set) var motionArtworkURL: String?

    // MARK: Engine

    private let engine = AVPlayer()
    private let streamLoader = StreamResourceLoader()
    private let streamLoaderQueue = DispatchQueue(label: "carmen.player.stream-loader")
    private let metaCache = TrackMetaCache()
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var statusObservation: NSKeyValueObservation?
    private var lyricTask: Task<Void, Never>?
    private var relatedTask: Task<Void, Never>?
    private var motionTask: Task<Void, Never>?
    private var lastActivityPush: Date = .distantPast
    private var lastResumeSave: Date = .distantPast
    private var lastNowPlayingSync: Date = .distantPast
    private var streamBroken = false
    /// videoId → center-cropped square artwork for the media session.
    private var artworkCache: [String: UIImage] = [:]
    private var artworkPending: Set<String> = []
    /// album/term key → motion mp4 URL ("" = catalogue says none).
    private var motionURLCache: [String: String] = [:]

    private var _shuffle = false
    private var _repeatModeRaw = RepeatMode.off.rawValue

    private static let shuffleKey = "carmen.player.shuffle"
    private static let repeatModeKey = "carmen.player.repeat"

    /// Fresh client per request so a Settings base-URL change applies at once.
    private var api: API { API(baseURL: SettingsStore.shared.apiBaseURL) }

    private let resumeKey = "carmen.player.resume"
    private let queueKey = "carmen.player.queue"

    var current: Track? {
        guard queue.indices.contains(currentIndex) else { return nil }
        return queue[currentIndex]
    }

    var hasQueue: Bool { !queue.isEmpty }

    var progress: Double {
        duration > 0 ? min(max(currentTime / duration, 0), 1) : 0
    }

    var hasNext: Bool {
        repeatMode != .off || shuffle || currentIndex + 1 < queue.count
    }

    var hasPrevious: Bool {
        currentTime > 3 || currentIndex > 0
    }

    private init() {
        _shuffle = UserDefaults.standard.bool(forKey: Self.shuffleKey)
        _repeatModeRaw = UserDefaults.standard.string(forKey: Self.repeatModeKey) ?? RepeatMode.off.rawValue
        configureAudioSession()
        observePlayback()
        configureRemoteCommands()
        restorePersistedQueue()
    }

    // MARK: - Presentation

    /// Expand the player from the mini bar (tap / swipe up). Mounts the
    /// overlay at expansion 0 first, then animates up — the async hop is what
    /// makes the slide actually play.
    func openPlayer() {
        guard !showNowPlaying || expansion < 1 else { return }
        expansion = 0
        showNowPlaying = true
        DispatchQueue.main.async {
            withAnimation(.spring(response: 0.42, dampingFraction: 0.86)) {
                self.expansion = 1
            }
        }
    }

    /// Collapse back to the mini bar, then unmount once the slide finished.
    func closePlayer() {
        withAnimation(.spring(response: 0.34, dampingFraction: 0.9)) {
            expansion = 0
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.55) { [weak self] in
            guard let self, self.expansion == 0 else { return }
            self.showNowPlaying = false
        }
    }

    // MARK: - Queue API

    /// Play one track, optionally with sibling tracks queued after it.
    func play(_ track: Track, startAt seconds: Double = 0, queue siblings: [Track]? = nil) {
        var list = (siblings ?? []).filter { $0.videoId != track.videoId }
        list.insert(track, at: 0)
        queue = list
        currentIndex = 0
        startCurrent(resumeAt: seconds)
    }

    /// Play a list of tracks starting at `index`.
    func play(_ tracks: [Track], startAt index: Int = 0) {
        guard !tracks.isEmpty else { return }
        queue = tracks
        currentIndex = min(max(index, 0), tracks.count - 1)
        startCurrent(resumeAt: 0)
    }

    func playNext(_ track: Track) {
        if queue.isEmpty {
            play(track)
            return
        }
        queue.insert(track, at: currentIndex + 1)
        persistQueue()
    }

    func enqueue(_ track: Track) {
        if queue.isEmpty {
            play(track)
            return
        }
        queue.append(track)
        persistQueue()
    }

    /// Queue a whole list right after the current track.
    func playNext(_ tracks: [Track]) {
        guard !tracks.isEmpty else { return }
        if queue.isEmpty {
            play(tracks)
            return
        }
        queue.insert(contentsOf: tracks, at: currentIndex + 1)
        persistQueue()
    }

    func removeFromQueue(at offsets: IndexSet) {
        let descending = offsets.sorted(by: >)
        var removedCurrent = false
        for index in descending where queue.indices.contains(index) {
            queue.remove(at: index)
            if index < currentIndex {
                currentIndex -= 1
            } else if index == currentIndex {
                removedCurrent = true
            }
        }
        if queue.isEmpty {
            stop()
            return
        }
        if removedCurrent {
            currentIndex = min(currentIndex, queue.count - 1)
            startCurrent(resumeAt: 0)
        } else {
            currentIndex = min(currentIndex, queue.count - 1)
            persistQueue()
        }
    }

    /// Jump the playhead to a queue entry (restarting it when it's current).
    func jump(to index: Int) {
        guard queue.indices.contains(index) else { return }
        if index == currentIndex {
            seek(to: 0)
            if !isPlaying {
                engine.play()
                isPlaying = true
                syncNowPlaying()
            }
            return
        }
        currentIndex = index
        startCurrent(resumeAt: 0)
    }

    func moveInQueue(from source: IndexSet, to destination: Int) {
        queue.move(fromOffsets: source, toOffset: destination)
        // Keep the playhead on the same track after the shuffle.
        guard let playing = current?.videoId else {
            currentIndex = min(currentIndex, queue.count - 1)
            return
        }
        if let newIndex = queue.firstIndex(where: { $0.videoId == playing }) {
            currentIndex = newIndex
        }
        persistQueue()
    }

    // MARK: - Transport

    func togglePlayPause() {
        guard hasQueue else { return }
        if isPlaying {
            engine.pause()
            isPlaying = false
            persistResume()
        } else if engine.currentItem == nil {
            // Restored queue that never started, or a torn-down stream.
            startCurrent(resumeAt: currentTime)
        } else {
            streamBroken = false
            engine.play()
            isPlaying = true
        }
        syncNowPlaying()
        pushLiveActivity(force: true)
    }

    /// Re-attempt the current track after a stream failure.
    func retry() {
        guard current != nil else { return }
        errorMessage = nil
        startCurrent(resumeAt: currentTime)
    }

    func seek(to seconds: Double) {
        let target = max(0, duration > 0 ? min(seconds, duration) : seconds)
        engine.seek(
            to: CMTime(seconds: target, preferredTimescale: 600),
            toleranceBefore: .zero,
            toleranceAfter: .zero
        )
        currentTime = target
        syncNowPlaying()
        pushLiveActivity(force: true)
    }

    func skipForward() { seek(to: currentTime + 15) }
    func skipBackward() { seek(to: currentTime > 10 ? currentTime - 10 : 0) }

    func next() { advance(manual: true) }

    func previous() {
        if currentTime > 3 {
            seek(to: 0)
        } else if currentIndex > 0 {
            currentIndex -= 1
            startCurrent(resumeAt: 0)
        } else {
            seek(to: 0)
        }
    }

    /// Queue panel "Clear": keep the current song playing, drop everything
    /// queued after it (Apple Music / frontend `clearQueue` semantics).
    func clearUpcoming() {
        guard let current else { return }
        queue = [current]
        currentIndex = 0
        persistQueue()
    }

    func stop() {
        lyricTask?.cancel()
        relatedTask?.cancel()
        motionTask?.cancel()
        engine.pause()
        engine.replaceCurrentItem(with: nil)
        isPlaying = false
        isBuffering = false
        streamBroken = false
        currentTime = 0
        duration = 0
        queue = []
        currentIndex = 0
        lyrics = nil
        related = []
        relatedVideoId = nil
        relatedLoading = false
        motionArtworkURL = nil
        errorMessage = nil
        UserDefaults.standard.removeObject(forKey: resumeKey)
        UserDefaults.standard.removeObject(forKey: queueKey)
        LyricActivityController.shared.end()
        syncNowPlaying()
        if showNowPlaying { closePlayer() }
    }

    // MARK: - Stations / watch

    /// "Play similar" — `/watch?videoId=…&radio=true` builds a station around
    /// the seed track (same as the web client's radio button).
    func playStation(seed: Track) {
        Task { await loadWatch(videoId: seed.videoId, playlistId: nil, radio: true, prefer: seed.videoId) }
    }

    /// Station / playlist queue from a card tap (`RD…` mix ids, `VL…` lists).
    func playWatch(videoId: String? = nil, playlistId: String? = nil, radio: Bool = false) {
        Task { await loadWatch(videoId: videoId, playlistId: playlistId, radio: radio, prefer: videoId) }
    }

    /// Queue an album/playlist/related list starting from `track` when given.
    func play(_ tracks: [Track], startingAt track: Track?) {
        guard !tracks.isEmpty else { return }
        if let track, let index = tracks.firstIndex(where: { $0.videoId == track.videoId }) {
            play(tracks, startAt: index)
        } else {
            play(tracks, startAt: 0)
        }
    }

    private func loadWatch(videoId: String?, playlistId: String?, radio: Bool, prefer: String?) async {
        errorMessage = nil
        isBuffering = true
        defer { isBuffering = false }
        do {
            let tracks = try await api.watch(videoId: videoId, playlistId: playlistId, radio: radio)
            guard !tracks.isEmpty else {
                errorMessage = "No playable tracks came back."
                return
            }
            if let prefer, let index = tracks.firstIndex(where: { $0.videoId == prefer }) {
                play(tracks, startAt: index)
            } else {
                play(tracks, startAt: 0)
            }
        } catch is CancellationError {
            // superseded by another tap
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Engine plumbing

    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default)
        try? session.setActive(true)
    }

    private func startCurrent(resumeAt seconds: Double) {
        guard let track = current else { return }
        errorMessage = nil
        streamBroken = false
        isBuffering = true
        lyrics = nil
        currentTime = max(0, seconds)
        duration = Double(track.durationSeconds ?? parseDurationSeconds(track.durationLabel) ?? 0)
        persistQueue()
        persistResume()
        syncNowPlaying()
        pushLiveActivity(force: true)
        loadLyrics(for: track)
        loadRelated(for: track)
        resolveMotionArtwork(for: track)
        updateRemoteCommands()

        // Source chain: downloaded file → `carmen-cache://` (disk cache) →
        // failure. A saved song never touches the network again.
        let item: AVPlayerItem
        if let local = DownloadsStore.shared.audioURL(videoId: track.videoId) {
            item = AVPlayerItem(url: local)
        } else if let url = api.cachedStreamURL(videoId: track.videoId) {
            let asset = AVURLAsset(url: url)
            // The delegate must be attached before the asset is ever used.
            asset.resourceLoader.setDelegate(streamLoader, queue: streamLoaderQueue)
            item = AVPlayerItem(asset: asset)
        } else {
            handleStreamFailure(for: track, detail: "missing stream url")
            return
        }

        statusObservation?.invalidate()
        statusObservation = item.observe(\.status, options: [.new]) { [weak self] observed, _ in
            guard observed.status == .failed else { return }
            let message = observed.error.map { ($0 as NSError).localizedDescription } ?? ""
            Task { @MainActor in
                self?.handleStreamFailure(for: track, detail: message)
            }
        }

        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.advance(manual: false)
            }
        }

        engine.replaceCurrentItem(with: item)
        if currentTime > 0 {
            engine.seek(
                to: CMTime(seconds: currentTime, preferredTimescale: 600),
                toleranceBefore: .zero,
                toleranceAfter: .zero
            )
        }
        engine.play()
        isPlaying = true
        LibraryStore.shared.recordPlay(track)
    }

    private func handleStreamFailure(for track: Track, detail: String) {
        guard current?.videoId == track.videoId, !streamBroken else { return }
        streamBroken = true
        engine.pause()
        isPlaying = false
        isBuffering = false
        syncNowPlaying()
        // Probe the endpoint so the user sees the server's actual reason.
        Task { [weak self] in
            guard let self else { return }
            let probed = await self.api.streamError(videoId: track.videoId)
            guard self.current?.videoId == track.videoId else { return }
            let reason = probed ?? (detail.isEmpty ? "The stream stopped." : detail)
            self.errorMessage = "Can't play “\(track.title)” — \(reason)"
        }
    }

    private func advance(manual: Bool) {
        guard !queue.isEmpty else { return }

        if repeatMode == .one, !manual {
            startCurrent(resumeAt: 0)
            return
        }

        if shuffle, queue.count > 1 {
            var next = currentIndex
            while next == currentIndex { next = Int.random(in: 0..<queue.count) }
            currentIndex = next
            startCurrent(resumeAt: 0)
            return
        }

        if currentIndex + 1 < queue.count {
            currentIndex += 1
            startCurrent(resumeAt: 0)
        } else if manual {
            // The user explicitly skipped past the last track — wrap to the
            // start (Apple Music behaviour).
            currentIndex = 0
            startCurrent(resumeAt: 0)
        } else if continueWithRelated() {
            // Frontend parity: the related list keeps the music going when
            // the queue runs out (starts playback internally).
        } else if repeatMode == .all {
            currentIndex = 0
            startCurrent(resumeAt: 0)
        } else {
            // Natural end of the queue with repeat off: park at the end.
            engine.pause()
            isPlaying = false
            currentTime = duration
            syncNowPlaying()
            pushLiveActivity(force: true)
        }
    }

    private func observePlayback() {
        let interval = CMTime(seconds: 0.5, preferredTimescale: 600)
        timeObserver = engine.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
            MainActor.assumeIsolated {
                guard let self, self.hasQueue else { return }
                if time.seconds.isFinite {
                    self.currentTime = time.seconds
                }
                if let item = self.engine.currentItem {
                    let itemDuration = item.duration.seconds
                    if itemDuration.isFinite, itemDuration > 0 {
                        self.duration = itemDuration
                    }
                    if self.isBuffering, item.status == .readyToPlay {
                        self.isBuffering = false
                    }
                }
                self.syncNowPlayingThrottled()
                self.pushLiveActivity()
                if Date().timeIntervalSince(self.lastResumeSave) > 5 {
                    self.persistResume()
                }
            }
        }
    }

    // MARK: - Lyrics

    private func loadLyrics(for track: Track) {
        lyricTask?.cancel()
        let provider = SettingsStore.shared.lyricsProviderParam
        let wantSynced = syncedLyricsEnabled

        // Offline first: a downloaded song's `track.json` already carries its
        // lyrics — only fall back to the network when it has none (same rule
        // as the web client).
        if let offline = Self.resolveLyrics(
            DownloadsStore.shared.detail(videoId: track.videoId)?.lyrics,
            wantSynced: wantSynced
        ) {
            lyrics = offline
            pushLiveActivity(force: true)
            return
        }

        lyricTask = Task { [weak self] in
            guard let self else { return }
            // Small delay so rapid skips only fetch the track that sticks.
            try? await Task.sleep(for: .milliseconds(400))
            if Task.isCancelled { return }
            self.lyricsLoading = true
            defer { self.lyricsLoading = false }
            do {
                let detail = try await self.api.trackDetail(track.videoId, provider: provider)
                if Task.isCancelled { return }
                self.lyrics = Self.resolveLyrics(detail.lyrics, wantSynced: wantSynced)
            } catch is CancellationError {
                return
            } catch {
                if Task.isCancelled { return }
                self.lyrics = nil
            }
            self.pushLiveActivity(force: true)
        }
    }

    /// Re-fetch the current track's lyrics (after a provider switch).
    func reloadLyrics() {
        guard let track = current else { return }
        loadLyrics(for: track)
    }

    /// Synced lines when asked for (and available), else the plain text.
    private static func resolveLyrics(_ lyrics: Lyrics?, wantSynced: Bool) -> Lyrics? {
        guard var resolved = lyrics else { return nil }
        if !wantSynced, resolved.hasSyncedLines {
            let plain = resolved.plainText
            resolved.synced = nil
            resolved.unsynced = plain
        }
        return resolved
    }

    // MARK: - Remote commands & Now Playing info

    /// Command handlers don't document a delivery queue — hop safely.
    private nonisolated func onMain(_ work: @escaping @MainActor () -> Void) {
        if Thread.isMainThread {
            MainActor.assumeIsolated { work() }
        } else {
            DispatchQueue.main.async { MainActor.assumeIsolated { work() } }
        }
    }

    private func configureRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.onMain {
                if self.hasQueue, !self.isPlaying { self.togglePlayPause() }
            }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.onMain {
                if self.hasQueue, self.isPlaying { self.togglePlayPause() }
            }
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.onMain { self.togglePlayPause() }
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.onMain { self.next() }
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            self.onMain { self.previous() }
            return .success
        }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let self, let event = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            let target = event.positionTime
            self.onMain {
                if self.hasQueue { self.seek(to: target) }
            }
            return .success
        }
        updateRemoteCommands()
    }

    private func updateRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        center.nextTrackCommand.isEnabled = hasQueue
        center.previousTrackCommand.isEnabled = hasQueue
        center.changePlaybackPositionCommand.isEnabled = hasQueue
        center.playCommand.isEnabled = true
        center.pauseCommand.isEnabled = hasQueue
    }

    private func syncNowPlayingThrottled() {
        guard Date().timeIntervalSince(lastNowPlayingSync) > 1 else { return }
        syncNowPlaying()
    }

    private func syncNowPlaying() {
        lastNowPlayingSync = Date()
        let info = MPNowPlayingInfoCenter.default()
        guard let track = current else {
            info.nowPlayingInfo = [:]
            return
        }
        var dict: [String: Any] = [
            MPMediaItemPropertyTitle: track.title,
            MPMediaItemPropertyArtist: track.artistLine,
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: currentTime,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
        ]
        if !track.albumName.isEmpty {
            dict[MPMediaItemPropertyAlbumTitle] = track.albumName
        }
        // The media session wants 1:1 — hand it the center crop, never the
        // raw 16:9 thumbnail (which renders stretched in Control Center).
        if let square = artworkCache[track.videoId] {
            dict[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: square.size) { _ in square }
        }
        // iOS 26 lock-screen motion artwork, when the track has any.
        if let motionURL = motionArtworkURL {
            dict = animatedArtwork(dict, track: track, motionURL: motionURL)
        }
        info.nowPlayingInfo = dict

        // Kick the artwork fetch once per track; the cache is consulted on
        // every later sync so the square crop lands as soon as it exists.
        if artworkCache[track.videoId] == nil, artworkPending.insert(track.videoId).inserted {
            Task { [weak self] in
                guard let self else { return }
                defer { self.artworkPending.remove(track.videoId) }
                _ = await self.squareArtwork(for: track)
            }
        }
    }

    /// Center-cropped square artwork for a track — the media session's 1:1
    /// image. Downloaded copy first (no network), then the payload artwork.
    func squareArtwork(for track: Track) async -> UIImage? {
        if let cached = artworkCache[track.videoId] { return cached }
        var image: UIImage?
        if let local = DownloadsStore.shared.artworkURL(videoId: track.videoId) {
            image = UIImage(contentsOfFile: local.path)
        }
        if image == nil, let remote = track.artwork ?? track.artworkAlt, let url = URL(string: remote),
            let (data, _) = try? await URLSession.shared.data(from: url)
        {
            image = UIImage(data: data)
        }
        guard let image else { return nil }
        let square = Self.centerSquare(of: image)
        artworkCache[track.videoId] = square
        if artworkCache.count > 30, let stale = artworkCache.keys.first(where: { $0 != track.videoId }) {
            artworkCache.removeValue(forKey: stale)
        }
        if current?.videoId == track.videoId { syncNowPlaying() }
        return square
    }

    /// Crop a rectangle down to its centered square (what the system views
    /// expect for `MPMediaItemArtwork` and the 1×1 animated-artwork slot).
    private static func centerSquare(of image: UIImage) -> UIImage {
        guard let cg = image.cgImage else { return image }
        let side = min(cg.width, cg.height)
        let origin = CGPoint(x: (cg.width - side) / 2, y: (cg.height - side) / 2)
        guard let cropped = cg.cropping(to: CGRect(origin: origin, size: CGSize(width: side, height: side)))
        else { return image }
        return UIImage(cgImage: cropped, scale: image.scale, orientation: image.imageOrientation)
    }

    /// Attach an `MPMediaItemAnimatedArtwork` (iOS 26) when the track has
    /// motion artwork. The system calls the handlers later: the preview must
    /// return a square image fast; the video handler may download the mp4 and
    /// must answer with a *local* file URL.
    private func animatedArtwork(_ dict: [String: Any], track: Track, motionURL: String) -> [String: Any] {
        guard #available(iOS 26.0, *) else { return dict }
        guard MPNowPlayingInfoCenter.supportedAnimatedArtworkKeys.contains(
            MPNowPlayingInfoProperty1x1AnimatedArtwork
        ) else { return dict }

        let preview = artworkCache[track.videoId]
        let artworkID = "carmen.\(track.album?.id ?? track.videoId)"
        var updated = dict
        let animated = MPMediaItemAnimatedArtwork(
            artworkID: artworkID,
            previewImageRequestHandler: { [weak self] _ in
                if let preview { return preview }
                guard let self else { return nil }
                return await self.squareArtwork(for: track)
            },
            videoAssetFileURLRequestHandler: { _ in
                await MotionArtwork.localFile(urlString: motionURL, id: artworkID)
            }
        )
        updated[MPNowPlayingInfoProperty1x1AnimatedArtwork] = animated
        return updated
    }

    // MARK: - Related songs

    /// Fetch `/browsing/related/{id}` for the current track (debounced so
    /// rapid skips only load the track that sticks). The first 10 feed the
    /// Home "Suggested for you" pool.
    private func loadRelated(for track: Track) {
        relatedTask?.cancel()
        relatedTask = Task { [weak self] in
            guard let self else { return }
            // Small delay so rapid skips only fetch the track that sticks.
            try? await Task.sleep(for: .milliseconds(400))
            if Task.isCancelled { return }
            self.relatedLoading = true
            do {
                let tracks = try await self.api.related(track.videoId, limit: 25)
                if Task.isCancelled { return }
                let cleaned = tracks.filter { $0.videoId != track.videoId }
                self.related = cleaned
                self.relatedVideoId = track.videoId
                self.relatedLoading = false
                LibraryStore.shared.addSuggestions(Array(cleaned.prefix(10)))
            } catch is CancellationError {
                self.relatedLoading = false
            } catch {
                if !Task.isCancelled {
                    self.related = []
                    self.relatedVideoId = track.videoId
                    self.relatedLoading = false
                }
            }
        }
    }

    /// Natural end of the queue → keep playing from the related list (the
    /// web client's buildNext: unplayed first, then the whole list again).
    @discardableResult private func continueWithRelated() -> Bool {
        guard relatedVideoId == current?.videoId, !related.isEmpty else { return false }
        let queued = Set(queue.map(\.videoId))
        let finished = current?.videoId
        var upcoming = related.filter { !queued.contains($0.videoId) && $0.videoId != finished }
        if upcoming.isEmpty {
            // Everything related is already queued — cycle the list anyway so
            // the music never just stops mid-session.
            upcoming = related.filter { $0.videoId != finished }
        }
        guard !upcoming.isEmpty else { return false }
        queue.append(contentsOf: upcoming)
        persistQueue()
        currentIndex += 1
        startCurrent(resumeAt: 0)
        return true
    }

    // MARK: - Motion artwork

    /// Walk the Apple-catalogue chain for the track's motion cover (album
    /// browse id → iTunes collection → mp4). "No motion art" caches too, so
    /// a track is only ever looked up once.
    private func resolveMotionArtwork(for track: Track) {
        motionTask?.cancel()
        motionArtworkURL = nil
        motionTask = Task { [weak self] in
            guard let self else { return }
            let resolved = await self.motionURL(for: track)
            if Task.isCancelled { return }
            self.motionArtworkURL = resolved
            self.syncNowPlaying()  // pick the animated artwork up (or drop it)
        }
    }

    private func motionURL(for track: Track) async -> String? {
        let key: String
        if let albumId = track.album?.id, !albumId.isEmpty {
            key = "album:\(albumId)"
        } else {
            key = "term:\(track.title)|\(track.artistLine)"
        }
        if let cached = motionURLCache[key] { return cached.isEmpty ? nil : cached }

        let api = self.api
        var resolved: String?
        do {
            var collectionId: Int?
            if let albumId = track.album?.id, albumId.hasPrefix("MPRE") {
                collectionId = try await api.itunesId(albumId)
            }
            if collectionId == nil {
                collectionId = try await api.itunesId(term: "\(track.title) - \(track.artistLine)", entity: "song")
            }
            if let collectionId {
                resolved = try await api.animatedArtwork(collectionId)
            }
        } catch is CancellationError {
            return nil
        } catch {
            resolved = nil
        }
        motionURLCache[key] = resolved ?? ""
        return resolved
    }

    // MARK: - Live Activity

    private func pushLiveActivity(force: Bool = false) {
        guard SettingsStore.shared.liveActivitiesEnabled else {
            if force { LyricActivityController.shared.end() }
            return
        }
        guard let track = current else {
            if force { LyricActivityController.shared.end() }
            return
        }
        if !force, Date().timeIntervalSince(lastActivityPush) < 1 { return }
        lastActivityPush = Date()

        let elapsedMs = Int((currentTime * 1000).rounded(.down))
        let active = lyrics?.displayLine(atMs: elapsedMs)
        let nextIndex = lyrics?.vocalLineIndex(atMs: elapsedMs)
        let nextLine = lyrics?.nextVocalLine(after: nextIndex)

        let state = LyricActivityAttributes.ContentState(
            line: active?.text ?? "",
            nextLine: nextLine?.text ?? "",
            title: track.title,
            artist: track.artistLine,
            artworkURL: track.artwork ?? track.artworkAlt,
            isPlaying: isPlaying,
            progress: progress,
            elapsed: currentTime,
            duration: duration
        )
        LyricActivityController.shared.update(state, videoId: track.videoId)
    }

    // MARK: - Persistence

    private func persistQueue() {
        guard let data = try? JSONEncoder().encode(queue) else { return }
        UserDefaults.standard.set(data, forKey: queueKey)
    }

    private func persistResume() {
        lastResumeSave = Date()
        guard let track = current else { return }
        let payload: [String: Any] = [
            "videoId": track.videoId,
            "time": currentTime,
            "index": currentIndex,
        ]
        UserDefaults.standard.set(payload, forKey: resumeKey)
    }

    /// Rehydrate the queue on launch. Playback itself never auto-starts
    /// (iOS requires user interaction) — the play button resumes from here.
    private func restorePersistedQueue() {
        defer { updateRemoteCommands() }
        guard let data = UserDefaults.standard.data(forKey: queueKey),
            let saved = try? JSONDecoder().decode([Track].self, from: data),
            !saved.isEmpty
        else { return }
        queue = saved
        let payload = UserDefaults.standard.dictionary(forKey: resumeKey) as? [String: Any]
        currentIndex = min(max(payload?["index"] as? Int ?? 0, 0), saved.count - 1)
        if let track = current {
            duration = Double(track.durationSeconds ?? parseDurationSeconds(track.durationLabel) ?? 0)
            if let time = payload?["time"] as? Double {
                currentTime = min(max(time, 0), duration)
            }
            syncNowPlaying()
        }
    }
}
