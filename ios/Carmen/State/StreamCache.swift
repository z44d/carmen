//
//  StreamCache.swift
//  Carmen — local byte cache behind every `/stream` playback URL.
//
//  AVPlayer points at a `carmen-cache://` URL; `StreamResourceLoader`
//  (an AVAssetResourceLoadingDelegate) serves bytes from
//  Library/Caches/streams/<hash>.bin when they are already on disk and fills
//  the gaps with ranged GETs against the real https endpoint. Bytes land on
//  disk as they stream in, so a seek into a half-downloaded file hits the
//  cache for everything played so far and replays never re-fetch the network.
//

import AVFoundation
import CryptoKit
import Foundation
import UniformTypeIdentifiers

/// One merged, half-open byte range written to a cache file.
private struct ByteRange: Codable, Equatable, Sendable {
    var start: Int64
    var end: Int64

    var count: Int64 { max(0, end - start) }
}

/// Disk-backed byte-range store, keyed by the remote URL. All methods are
/// synchronous and safe to call from any thread (internal serial queue).
final class StreamCache {
    static let shared = StreamCache()

    /// Cache cap — least-recently-written streams are evicted past this.
    private static let sizeCap: Int64 = 1_000_000_000

    /// What we know about a remote object without touching the network.
    struct Snapshot: Sendable {
        var total: Int64?
        var mime: String?
    }

    private struct Meta: Codable {
        var total: Int64?
        var mime: String?
        var ranges: [ByteRange] = []
    }

    private let queue = DispatchQueue(label: "carmen.stream-cache")
    private let directory: URL
    private let fileManager = FileManager.default
    private var metas: [String: Meta] = [:]

    private init() {
        let caches = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        directory = caches.appendingPathComponent("streams", isDirectory: true)
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    // MARK: - Meta

    /// Cached knowledge (total length, MIME) for a remote URL.
    func snapshot(_ url: URL) -> Snapshot {
        queue.sync {
            let meta = loadMeta(url)
            return Snapshot(total: meta.total, mime: meta.mime)
        }
    }

    /// Record probe results (merged; nil keeps the existing value).
    func record(total: Int64?, mime: String?, for url: URL) {
        queue.sync {
            var meta = loadMeta(url)
            if let total { meta.total = total }
            if let mime { meta.mime = mime }
            saveMeta(url, meta)
            pruneLocked()
        }
    }

    // MARK: - Reads / writes

    /// The longest already-cached prefix of `[offset, offset + maxCount)`,
    /// or nil when not a single byte at `offset` is on disk. Returning a
    /// short-but-useful run keeps the caller from re-fetching cached bytes
    /// that merely sit next to a gap.
    func readPrefix(_ url: URL, offset: Int64, maxCount: Int) -> Data? {
        guard maxCount > 0 else { return nil }
        return queue.sync { () -> Data? in
            let meta = loadMeta(url)
            guard let range = meta.ranges.first(where: { $0.start <= offset && offset < $0.end }) else { return nil }
            let available = Int(min(range.end - offset, Int64(maxCount)))
            guard available > 0 else { return nil }
            guard let handle = try? FileHandle(forReadingFrom: fileURL(url)) else { return nil }
            defer { try? handle.close() }
            try? handle.seek(toOffset: UInt64(max(0, offset)))
            guard let data = try? handle.read(upToCount: available), data.count > 0 else { return nil }
            return data
        }
    }

    /// First cached range that starts strictly after `offset` (nil = nothing
    /// further is cached — the gap runs to the end of the request).
    func nextCachedStart(after offset: Int64, _ url: URL) -> Int64? {
        queue.sync {
            loadMeta(url).ranges.lazy.filter { $0.start > offset }.map(\.start).min()
        }
    }

    /// Write bytes at an absolute file offset and record the range.
    func write(_ url: URL, offset: Int64, data: Data) {
        guard !data.isEmpty else { return }
        queue.sync {
            let path = fileURL(url)
            let isNew = !fileManager.fileExists(atPath: path.path)
            if isNew {
                fileManager.createFile(atPath: path.path, contents: nil)
                pruneLocked()
            }
            guard let handle = try? FileHandle(forWritingTo: path) else { return }
            defer { try? handle.close() }
            try? handle.seek(toOffset: UInt64(max(0, offset)))
            try? handle.write(contentsOf: data)

            var meta = loadMeta(url)
            insert(ByteRange(start: offset, end: offset + Int64(data.count)), into: &meta.ranges)
            saveMeta(url, meta)
        }
    }

    // MARK: - Internals (call with `queue` held)

    private func key(for url: URL) -> String {
        SHA256.hash(data: Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func fileURL(_ url: URL) -> URL {
        directory.appendingPathComponent(key(for: url) + ".bin")
    }

    private func metaURL(_ url: URL) -> URL {
        directory.appendingPathComponent(key(for: url) + ".json")
    }

    private func loadMeta(_ url: URL) -> Meta {
        if let cached = metas[key(for: url)] { return cached }
        var meta = Meta()
        if let data = try? Data(contentsOf: metaURL(url)),
            let decoded = try? JSONDecoder().decode(Meta.self, from: data)
        {
            meta = decoded
        }
        metas[key(for: url)] = meta
        return meta
    }

    private func saveMeta(_ url: URL, _ meta: Meta) {
        metas[key(for: url)] = meta
        if let data = try? JSONEncoder().encode(meta) {
            try? data.write(to: metaURL(url), options: .atomic)
        }
    }

    /// Merge `range` into a sorted, non-overlapping list.
    private func insert(_ range: ByteRange, into ranges: inout [ByteRange]) {
        ranges.append(range)
        ranges.sort { $0.start < $1.start }
        var merged: [ByteRange] = []
        for candidate in ranges {
            if let last = merged.last, candidate.start <= last.end {
                merged[merged.count - 1].end = max(last.end, candidate.end)
            } else {
                merged.append(candidate)
            }
        }
        ranges = merged
    }

    /// Evict least-recently-written streams until comfortably under the cap.
    private func pruneLocked() {
        let keys: [String]
        do {
            keys = try fileManager.contentsOfDirectory(atPath: directory.path)
        } catch {
            return
        }
        var entries: [(name: String, size: Int64, date: Date)] = []
        var total: Int64 = 0
        for name in keys {
            let url = directory.appendingPathComponent(name)
            let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            let size = Int64(values?.fileSize ?? 0)
            total += size
            entries.append((name, size, values?.contentModificationDate ?? .distantPast))
        }
        guard total > Self.sizeCap else { return }
        for entry in entries.sorted(by: { $0.date < $1.date }) where total > Self.sizeCap / 2 {
            try? fileManager.removeItem(at: directory.appendingPathComponent(entry.name))
            total -= entry.size
            // Drop the matching sidecar too so stale ranges never outlive data.
            let base = (entry.name as NSString).deletingPathExtension
            if entry.name.hasSuffix(".bin") {
                try? fileManager.removeItem(at: directory.appendingPathComponent(base + ".json"))
            }
        }
    }
}

/// Routes `carmen-cache://` playback URLs through `StreamCache`.
/// One instance lives on the Player; the asset's resource loader must get
/// its delegate before the `AVPlayerItem` is created.
final class StreamResourceLoader: NSObject, AVAssetResourceLoaderDelegate {
    static let scheme = "carmen-cache"

    private let cache = StreamCache.shared
    private let lock = NSLock()
    private var tasks: [ObjectIdentifier: Task<Void, Never>] = [:]

    func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest
    ) -> Bool {
        guard let requestURL = loadingRequest.request.url, requestURL.scheme == Self.scheme,
            var components = URLComponents(url: requestURL, resolvingAgainstBaseURL: false)
        else { return false }
        components.scheme = "https"
        guard let remote = components.url else { return false }

        let id = ObjectIdentifier(loadingRequest)
        let task = Task { [weak self] in
            guard let self else { return }
            await StreamLoad(cache: self.cache, request: loadingRequest, remote: remote).run()
            self.release(id)
        }
        lock.lock()
        tasks[id] = task
        lock.unlock()
        return true
    }

    func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        didCancel loadingRequest: AVAssetResourceLoadingRequest
    ) {
        let id = ObjectIdentifier(loadingRequest)
        lock.lock()
        let task = tasks[id]
        lock.unlock()
        task?.cancel()
        release(id)
    }

    private func release(_ id: ObjectIdentifier) {
        lock.lock()
        tasks[id] = nil
        lock.unlock()
    }
}

/// Fulfils one `AVAssetResourceLoadingRequest` from cache + ranged fetches.
///
/// Mobile connections stall and drop; AVPlayer answers a loader that goes
/// quiet with "The request timed out" and fails the whole item. So every
/// request here is raced against a short deadline and re-requested on the
/// spot (resuming at the byte it stopped on) — the gap is walked over, not
/// surfaced as a broken song.
private struct StreamLoad {
    /// 60s between chunks: the first byte goes through the server's cold
    /// yt-dlp resolution, which can sit for half a minute before answering;
    /// after that the stream is a fast transfer that never idles this long.
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 900
        return URLSession(configuration: configuration)
    }()

    /// Wall clock for one transfer attempt. Comfortably under the point
    /// where AVPlayer gives up on the loading request, so a stalled
    /// connection is re-requested while the player is still waiting.
    private static let attemptDeadline: Double = 8
    /// The cold resolution behind the very first request can idle much
    /// longer before the server even answers — give it its own, bigger leash.
    private static let probeDeadline: Double = 30
    /// Re-requests per gap, and per loading request, before giving up.
    private static let maxFetchAttempts = 4
    private static let maxLoadAttempts = 3

    /// Serve cached runs in ≤4 MB slabs — small enough to respond promptly,
    /// large enough that sequential playback is a handful of reads.
    /// (fileprivate: the batching `SlabTransfer` below flushes at it too.)
    fileprivate static let slabSize = 4_194_304

    let cache: StreamCache
    let request: AVAssetResourceLoadingRequest
    let remote: URL

    func run() async {
        var attempt = 0
        while true {
            do {
                try await load()
                if !request.isCancelled { request.finishLoading() }
                return
            } catch is CancellationError {
                // AVPlayer walked away — neither respond nor finish.
                return
            } catch let error as URLError where error.code == .cancelled {
                // Same: cancelled underneath us.
                return
            } catch {
                // `load()` resumes from `dataRequest.currentOffset`, so a
                // retry never re-sends bytes AVPlayer already took.
                attempt += 1
                guard attempt < Self.maxLoadAttempts, !Task.isCancelled, !request.isCancelled else {
                    DebugLog.log(
                        "stream",
                        "\(remote.lastPathComponent) load failed: \(error.localizedDescription)"
                    )
                    if !request.isCancelled { request.finishLoading(with: error) }
                    return
                }
                DebugLog.log(
                    "stream",
                    "\(remote.lastPathComponent) load attempt \(attempt) — \(error.localizedDescription)"
                )
                try? await Task.sleep(for: .milliseconds(400 * attempt))
            }
        }
    }

    private func load() async throws {
        var snapshot = cache.snapshot(remote)
        if snapshot.total == nil || snapshot.mime == nil {
            snapshot = try await probe()
            cache.record(total: snapshot.total, mime: snapshot.mime, for: remote)
        }

        if let info = request.contentInformationRequest {
            if let total = snapshot.total { info.contentLength = total }
            info.contentType = snapshot.mime.flatMap { UTType(mimeType: $0)?.identifier } ?? "public.mp4"
            info.isByteRangeAccessSupported = true
        }

        guard let dataRequest = request.dataRequest else { return }

        let offset = dataRequest.currentOffset
        var end: Int64
        if dataRequest.requestsAllDataToEndOfResource {
            end = snapshot.total ?? Int64.max
        } else if dataRequest.requestedLength > 0 {
            end = offset + Int64(dataRequest.requestedLength)
        } else {
            end = snapshot.total ?? Int64.max
        }
        if let total = snapshot.total, end > total { end = total }
        guard offset < end else { return }

        var position = offset
        var progressed = false
        while position < end {
            if Task.isCancelled || request.isCancelled { return }

            // Cache first: whatever prefix of the next slab already exists.
            if let cached = cache.readPrefix(remote, offset: position, maxCount: Self.slabSize),
                !cached.isEmpty
            {
                dataRequest.respond(with: cached)
                position += Int64(cached.count)
                progressed = true
                continue
            }

            // Gap — fetch exactly the missing span (never past the next run).
            let gapEnd = min(cache.nextCachedStart(after: position, remote) ?? end, end)
            let delivered = try await fetch(start: position, stop: gapEnd, window: position..<end) { chunk in
                dataRequest.respond(with: chunk)
            }
            if delivered > 0 {
                position += delivered
                progressed = true
            } else if progressed {
                break  // object ended short of the window — everything it has was sent
            } else {
                throw Self.streamError("The stream ended before any data arrived.")
            }
        }
    }

    // MARK: Networking

    /// Cheap `bytes=0-0` probe for total length + MIME type.
    private func probe() async throws -> StreamCache.Snapshot {
        var urlRequest = URLRequest(url: remote)
        urlRequest.setValue("bytes=0-0", forHTTPHeaderField: "Range")
        let (data, response) = try await Self.session.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse else {
            throw Self.streamError("The stream returned no response.")
        }
        DebugLog.log(
            "stream",
            "probe \(remote.lastPathComponent) → \(http.statusCode), \(http.mimeType ?? "?")"
        )
        if http.statusCode == 206 {
            let total = (http.value(forHTTPHeaderField: "Content-Range") ?? "")
                .split(separator: "/")
                .last
                .flatMap { Int64($0) }
            return StreamCache.Snapshot(total: total, mime: http.mimeType)
        }
        guard (200...299).contains(http.statusCode) else {
            throw Self.streamError(Self.detail(from: data) ?? "The stream failed (\(http.statusCode)).")
        }
        // No range support: the body would be the whole object — only trust
        // the length when the server actually declared one.
        let total = http.expectedContentLength > 0 ? http.expectedContentLength : nil
        return StreamCache.Snapshot(total: total, mime: http.mimeType)
    }

    /// Range GET for `[start, stop)`; writes every byte to the cache and hands
    /// the slice that overlaps `window` to `onChunk`. Returns how far the
    /// window advanced (0 = the object had nothing left to give).
    ///
    /// A stalled attempt is torn down and re-requested from the byte it
    /// reached, so the bytes AVPlayer already took are never sent twice.
    private func fetch(
        start: Int64, stop: Int64, window: Range<Int64>,
        onChunk: @escaping (Data) -> Void
    ) async throws -> Int64 {
        let transfer = SlabTransfer(cache: cache, remote: remote, window: window, onChunk: onChunk)
        var requestStart = start
        var attempt = 0
        while true {
            // Snapshot for the @Sendable deadline closure.
            let attemptStart = requestStart
            transfer.begin(at: attemptStart)
            do {
                try await Self.withDeadline(Self.attemptDeadline) {
                    try await Self.fetchOnce(remote: remote, from: attemptStart, stop: stop, into: transfer)
                }
                return transfer.delivered
            } catch {
                if Task.isCancelled { throw CancellationError() }
                // Bank whatever arrived before the stall — the retry resumes
                // exactly there instead of refetching it.
                transfer.flush()
                let resumeAt = transfer.absolute
                attempt += 1
                guard attempt < Self.maxFetchAttempts, resumeAt < stop else { throw error }
                requestStart = resumeAt
                DebugLog.log(
                    "stream",
                    "fetch stalled at \(requestStart): \(error.localizedDescription) — retry \(attempt)"
                )
                try? await Task.sleep(for: .milliseconds(300 * attempt))
            }
        }
    }

    /// One ranged request, raced by `fetch` against the attempt deadline.
    private static func fetchOnce(
        remote: URL, from start: Int64, stop: Int64, into transfer: SlabTransfer
    ) async throws {
        var urlRequest = URLRequest(url: remote)
        if stop == Int64.max {
            urlRequest.setValue("bytes=\(start)-", forHTTPHeaderField: "Range")
        } else {
            urlRequest.setValue("bytes=\(start)-\(stop - 1)", forHTTPHeaderField: "Range")
        }

        let (bytes, response) = try await session.bytes(for: urlRequest)
        guard let http = response as? HTTPURLResponse else {
            throw streamError("The stream returned no response.")
        }
        DebugLog.log("stream", "fetch \(urlRequest.value(forHTTPHeaderField: "Range") ?? "") → \(http.statusCode)")
        if http.statusCode == 416 { return }  // asked past the end — caller wraps up
        guard (200...299).contains(http.statusCode) else {
            let body = await collectBody(bytes)
            throw streamError(detail(from: body) ?? "The stream failed (\(http.statusCode)).")
        }

        // 206 bodies start at `start`; a bare 200 starts at 0 (no ranges).
        transfer.begin(at: http.statusCode == 206 ? start : 0)
        // `AsyncBytes` yields raw bytes — batch them into slab-sized chunks.
        for try await byte in bytes {
            if Task.isCancelled { throw CancellationError() }
            transfer.append(byte)
        }
        transfer.flush()
    }

    /// Run `operation` against a wall-clock deadline. Whichever finishes
    /// first wins; the loser is cancelled (which tears down its URLSession
    /// task). A timeout surfaces as `URLError(.timedOut)`.
    private static func withDeadline(
        _ seconds: Double, _ operation: @escaping @Sendable () async throws -> Void
    ) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(max(0.5, seconds) * 1_000_000_000))
                throw URLError(.timedOut)
            }
            defer { group.cancelAll() }
            // nil would mean an empty group — impossible here, but fail safe.
            let completed = try await group.next()
            if completed == nil { throw URLError(.timedOut) }
        }
    }

    // MARK: Error payloads

    private static func streamError(_ message: String) -> NSError {
        NSError(domain: "carmen.stream", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    private static func collectBody(_ bytes: URLSession.AsyncBytes) async -> Data {
        var data = Data()
        var iterator = bytes.makeAsyncIterator()
        while let chunk = try? await iterator.next() {
            data.append(chunk)
            if data.count > 1024 { break }
        }
        return data
    }

    private static func detail(from data: Data) -> String? {
        struct Detail: Decodable { let detail: String? }
        guard let detail = (try? JSONDecoder().decode(Detail.self, from: data))?.detail, !detail.isEmpty else {
            return nil
        }
        return detail
    }
}

/// The bytes of one gap, carried across re-requests: how far the body got
/// (`absolute`), how much of that landed inside the caller's window
/// (`delivered`), and the not-yet-flushed batch. `AsyncBytes` hands back one
/// byte at a time, so batching here is what keeps the cache and AVPlayer fed.
private final class SlabTransfer: @unchecked Sendable {
    private let cache: StreamCache
    private let remote: URL
    private let window: Range<Int64>
    private let onChunk: (Data) -> Void
    private var pending = Data()

    private(set) var absolute: Int64 = 0
    private(set) var delivered: Int64 = 0

    init(cache: StreamCache, remote: URL, window: Range<Int64>, onChunk: @escaping (Data) -> Void) {
        self.cache = cache
        self.remote = remote
        self.window = window
        self.onChunk = onChunk
    }

    /// Start (or restart) the body at `offset`, dropping the partial batch.
    func begin(at offset: Int64) {
        absolute = offset
        pending.removeAll(keepingCapacity: true)
    }

    func append(_ byte: UInt8) {
        pending.append(byte)
        if pending.count >= StreamLoad.slabSize { flush() }
    }

    /// Write the batch to disk and hand the window's slice to the loader.
    func flush() {
        guard !pending.isEmpty else { return }
        let chunk = pending
        pending.removeAll(keepingCapacity: true)
        cache.write(remote, offset: absolute, data: chunk)
        let chunkStart = absolute
        absolute += Int64(chunk.count)

        let overlapStart = max(chunkStart, window.lowerBound)
        let overlapEnd = min(absolute, window.upperBound)
        if overlapStart < overlapEnd {
            let lower = Int(overlapStart - chunkStart)
            let upper = Int(overlapEnd - chunkStart)
            onChunk(chunk.subdata(in: lower..<upper))
            delivered += overlapEnd - overlapStart
        }
    }
}
