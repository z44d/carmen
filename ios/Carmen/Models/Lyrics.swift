//
//  Lyrics.swift
//  Carmen — lyric payload + line timing.
//
//  `/browsing/track/{id}` returns `lyrics: {browseId, synced, unsynced,
//  source}` where `synced` lines carry `timeMs`, `endTimeMs` (server-computed:
//  next line's start, last line +4000ms) and optional per-word karaoke
//  stamps from enhanced LRC.
//

import Foundation

struct Lyrics: Codable, Hashable, Sendable {
    struct Word: Codable, Hashable, Sendable {
        var text: String
        var startMs: Int
        var endMs: Int
    }

    struct Line: Codable, Hashable, Sendable {
        var timeMs: Int
        var endTimeMs: Int?
        var text: String
        var words: [Word]?

        /// Effective end of the line — falls back to the next line's start.
        func endMs(nextStartMs: Int?) -> Int {
            if let endTimeMs { return endTimeMs }
            if let nextStartMs { return nextStartMs }
            return timeMs + 4000
        }

        /// True for filler rows (`♪`, blank) that carry no words.
        var isFiller: Bool {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty || trimmed.allSatisfy { $0 == "♪" || $0 == "\u{ff}" }
        }
    }

    var browseId: String?
    var synced: [Line]?
    var unsynced: String?
    var source: String?

    var hasSyncedLines: Bool { !(synced?.isEmpty ?? true) }

    /// Plain text for the unsynced view — synced lines joined when that is all
    /// the provider gave (mirrors the server's own `unsynced` derivation).
    var plainText: String? {
        if let unsynced, !unsynced.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return unsynced }
        guard hasSyncedLines else { return nil }
        let joined = (synced ?? [])
            .filter { !$0.isFiller }
            .map { $0.text.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
        return joined.isEmpty ? nil : joined
    }

    /// Index of the active line at `ms`, or nil before the first line.
    func lineIndex(atMs ms: Int) -> Int? {
        guard let lines = synced, !lines.isEmpty else { return nil }
        var result: Int?
        for (index, line) in lines.enumerated() {
            if line.timeMs <= ms { result = index } else { break }
        }
        return result
    }

    /// Index of the active line, skipping filler (`♪`) rows so the Live
    /// Activity and the player never show an instrumental marker as "the
    /// current lyric". Falls forward past a run of fillers when no vocal line
    /// precedes the playhead yet.
    func vocalLineIndex(atMs ms: Int) -> Int? {
        guard let original = lineIndex(atMs: ms) else { return nil }
        let lines = synced ?? []
        var i = original
        while i >= 0, lines[i].isFiller { i -= 1 }
        if i >= 0 { return i }
        var j = original
        while j < lines.count, lines[j].isFiller { j += 1 }
        return j < lines.count ? j : nil
    }

    /// Next non-filler line after `index` (nil at the end).
    func nextVocalLine(after index: Int?) -> Line? {
        guard let index, let lines = synced else { return nil }
        var i = index + 1
        while i < lines.count {
            if !lines[i].isFiller { return lines[i] }
            i += 1
        }
        return nil
    }

    /// The lyric line the Live Activity should show for `ms`: the current
    /// vocal line, or nil when before the first line / no lyrics.
    func displayLine(atMs ms: Int) -> Line? {
        guard let index = vocalLineIndex(atMs: ms), let lines = synced else { return nil }
        return lines[index]
    }
}

/// In-memory LRU of enriched track payloads (metadata + lyrics), keyed by
/// `videoId:provider` exactly like the web client's `trackMetaCache`.
actor TrackMetaCache {
    private var storage: [String: TrackDetail] = [:]
    private var order: [String] = []
    private let capacity = 48

    func value(for key: String) -> TrackDetail? {
        guard let value = storage[key] else { return nil }
        order.removeAll { $0 == key }
        order.append(key)
        return value
    }

    func store(_ detail: TrackDetail, for key: String) {
        if storage[key] == nil { order.append(key) }
        storage[key] = detail
        while order.count > capacity, let oldest = order.first {
            order.removeFirst()
            storage[oldest] = nil
        }
    }
}
