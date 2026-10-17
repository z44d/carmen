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
private struct StreamLoad {
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 900
        return URLSession(configuration: configuration)
    }()

    /// Serve cached runs in ≤4 MB slabs — small enough to respond promptly,
    /// large enough that sequential playback is a handful of reads.
    private static let slabSize = 4_194_304

    let cache: StreamCache
    let request: AVAssetResourceLoadingRequest
    let remote: URL

    func run() async {
        do {
            try await load()
            if !request.isCancelled { request.finishLoading() }
        } catch is CancellationError {
            // AVPlayer walked away — neither respond nor finish.
        } catch let error as URLError where error.code == .cancelled {
            // Same: cancelled underneath us.
        } catch {
            if !request.isCancelled { request.finishLoading(with: error) }
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
                throw streamError("The stream ended before any data arrived.")
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
            throw streamError("The stream returned no response.")
        }
        if http.statusCode == 206 {
            let total = (http.value(forHTTPHeaderField: "Content-Range") ?? "")
                .split(separator: "/")
                .last
                .flatMap { Int64($0) }
            return StreamCache.Snapshot(total: total, mime: http.mimeType)
        }
        guard (200...299).contains(http.statusCode) else {
            throw streamError(Self.detail(from: data) ?? "The stream failed (\(http.statusCode)).")
        }
        // No range support: the body would be the whole object — only trust
        // the length when the server actually declared one.
        let total = http.expectedContentLength > 0 ? http.expectedContentLength : nil
        return StreamCache.Snapshot(total: total, mime: http.mimeType)
    }

    /// Range GET for `[start, stop)`; writes every byte to the cache and hands
    /// the slice that overlaps `window` to `onChunk`. Returns how far the
    /// window advanced (0 = the object had nothing left to give).
    private func fetch(
        start: Int64, stop: Int64, window: Range<Int64>,
        onChunk: (Data) -> Void
    ) async throws -> Int64 {
        var urlRequest = URLRequest(url: remote)
        if stop == Int64.max {
            urlRequest.setValue("bytes=\(start)-", forHTTPHeaderField: "Range")
        } else {
            urlRequest.setValue("bytes=\(start)-\(stop - 1)", forHTTPHeaderField: "Range")
        }

        let (bytes, response) = try await Self.session.bytes(for: urlRequest)
        guard let http = response as? HTTPURLResponse else {
            throw streamError("The stream returned no response.")
        }
        if http.statusCode == 416 { return 0 }  // asked past the end — caller wraps up
        guard (200...299).contains(http.statusCode) else {
            let body = await Self.collectBody(bytes)
            throw streamError(Self.detail(from: body) ?? "The stream failed (\(http.statusCode)).")
        }

        // 206 bodies start at `start`; a bare 200 starts at 0 (no ranges).
        let bodyStart = http.statusCode == 206 ? start : 0
        var absolute = bodyStart
        var delivered: Int64 = 0
        // `AsyncBytes` yields raw bytes — batch them into slab-sized chunks.
        var pending = Data()

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

        for try await byte in bytes {
            if Task.isCancelled { throw CancellationError() }
            pending.append(byte)
            if pending.count >= Self.slabSize { flush() }
        }
        flush()
        return delivered
    }

    // MARK: Error payloads

    private func streamError(_ message: String) -> NSError {
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
