//
//  Models.swift
//  Carmen — domain models for the Carmen API payloads.
//
//  The backend is deliberately untyped JSON (ytmusicapi shapes vary per
//  endpoint: `artists` is a list of objects here and a plain string there,
//  duration arrives as `duration_seconds` / `duration` / `length`, artwork as
//  `thumbnails` / `thumbnail` / `artwork`). Decoding is therefore defensive:
//  every field is optional-ised and normalized at decode time, mirroring
//  frontend/src/utils/track.ts so both clients agree on the same data.
//

import Foundation

// MARK: - Primitives

struct Thumbnail: Codable, Hashable, Sendable {
    var url: String
    var width: Int?
    var height: Int?
}

/// One entry of `artists` — the API is inconsistent: `["name"]` or `[{name,id}]`.
struct ArtistRef: Codable, Hashable, Sendable {
    var name: String
    var id: String?

    init(name: String, id: String? = nil) {
        self.name = name
        self.id = id
    }

    init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer().decode(String.self) {
            self.init(name: single)
            return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        guard !name.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .name, in: c, debugDescription: "artist without a name")
        }
        self.init(name: name, id: (try? c.decodeIfPresent(String.self, forKey: .id)) ?? nil)
    }
}

/// Album reference — `"Album"` or `{name, id}` depending on the endpoint.
struct AlbumRef: Codable, Hashable, Sendable {
    var name: String
    var id: String?

    init(name: String, id: String? = nil) {
        self.name = name
        self.id = id
    }

    init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer().decode(String.self) {
            self.init(name: single)
            return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        guard !name.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .name, in: c, debugDescription: "album without a name")
        }
        self.init(name: name, id: (try? c.decodeIfPresent(String.self, forKey: .id)) ?? nil)
    }
}

/// `"3:36"` / `"1:02:03"` → seconds. Also accepts an Int-ish string.
func parseDurationSeconds(_ value: String?) -> Int? {
    guard let value = value?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { return nil }
    if let whole = Int(value) { return whole }
    let parts = value.split(separator: ":").map(String.init)
    guard (2...3).contains(parts.count), parts.allSatisfy({ Int($0) != nil }) else { return nil }
    var seconds = 0
    for part in parts { seconds = seconds * 60 + (Int(part) ?? 0) }
    return seconds
}

/// `216` → `"3:36"`.
func formatDuration(_ seconds: Int?) -> String? {
    guard let seconds, seconds >= 0 else { return nil }
    let h = seconds / 3600
    let m = (seconds % 3600) / 60
    let s = seconds % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
}

/// `216` → `"3:36"` for a TimeInterval (used by the player clock).
func formatClock(_ time: TimeInterval) -> String {
    let total = Int(time.rounded(.down))
    return formatDuration(max(total, 0)) ?? "0:00"
}

// MARK: - Artwork picking (mirrors pickArtwork / primaryArtwork on the web)

private func isWebP(_ url: String) -> Bool {
    url.range(of: "\\.webp([?#]|$)", options: .regularExpression) != nil
}

private func area(_ thumb: Thumbnail) -> Int {
    let w = thumb.width ?? 0
    let h = thumb.height ?? 0
    return w * h != 0 ? w * h : max(thumb.width ?? 0, thumb.height ?? 0)
}

/// Largest usable URL out of any number of thumbnail lists; JPEG preferred
/// over webp (the sanitizer already rewrites most of them, but not all).
func pickArtwork(_ lists: [Thumbnail]?...) -> String? {
    var all: [Thumbnail] = []
    for list in lists {
        guard let thumbs = list else { continue }
        all.append(contentsOf: thumbs.filter { !$0.url.isEmpty })
    }
    guard !all.isEmpty else { return nil }
    let sorted = all.sorted { area($0) > area($1) }
    if let jpeg = sorted.first(where: { !isWebP($0.url) }) { return jpeg.url }
    return sorted.first?.url
}

/// Songs always resolve through the i.ytimg CDN (same rule as the web client).
func cdnArtwork(_ videoId: String?) -> String? {
    guard let videoId, !videoId.isEmpty else { return nil }
    return "https://i.ytimg.com/vi/\(videoId)/maxresdefault.jpg"
}

// MARK: - Failable array decoding

private struct Failable<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) { value = try? T(from: decoder) }
}

extension KeyedDecodingContainer {
    /// Array decode that skips individual broken entries instead of failing
    /// the whole payload (home rows mix card shapes on purpose).
    func decodeSkippingFailures<T: Decodable>(_ type: T.Type, forKey key: Key) -> [T] {
        guard let raw = try? decode([Failable<T>].self, forKey: key) else { return [] }
        return raw.compactMap(\.value)
    }
}

// MARK: - Track

/// Normalized track — the shape every list and the player consume.
struct Track: Codable, Hashable, Identifiable, Sendable {
    var videoId: String
    var title: String
    var artists: [ArtistRef]
    var album: AlbumRef?
    var durationLabel: String?
    var durationSeconds: Int?
    /// Primary artwork (i.ytimg CDN for songs) + a payload-derived fallback.
    var artwork: String?
    var artworkAlt: String?
    var year: String?
    var isExplicit: Bool
    /// Album playlist id (`OLAK…`) when the payload carries one.
    var playlistId: String?

    var artistLine: String {
        let names = artists.map(\.name).filter { !$0.isEmpty }.joined(separator: ", ")
        return names.isEmpty ? "Unknown artist" : names
    }

    var albumName: String { album?.name ?? "" }
    var id: String { videoId }

    private enum CodingKeys: String, CodingKey {
        case videoId, title, artists, artist, album, duration, length
        case duration_seconds, lengthSeconds, thumbnails, thumbnail, artwork
        case year, isExplicit, playlistId
    }

    init(
        videoId: String, title: String, artists: [ArtistRef], album: AlbumRef? = nil,
        durationLabel: String? = nil, durationSeconds: Int? = nil,
        artwork: String? = nil, artworkAlt: String? = nil,
        year: String? = nil, isExplicit: Bool = false, playlistId: String? = nil
    ) {
        self.videoId = videoId
        self.title = title
        self.artists = artists
        self.album = album
        self.durationLabel = durationLabel
        self.durationSeconds = durationSeconds
        self.artwork = artwork
        self.artworkAlt = artworkAlt
        self.year = year
        self.isExplicit = isExplicit
        self.playlistId = playlistId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let videoId = (try? c.decodeIfPresent(String.self, forKey: .videoId)), !videoId.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .videoId, in: c, debugDescription: "track without videoId")
        }
        let title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""

        var artists = (try? c.decodeIfPresent([ArtistRef].self, forKey: .artists)) ?? []
        if artists.isEmpty, let single = (try? c.decodeIfPresent(String.self, forKey: .artist)), !single.isEmpty {
            artists = [ArtistRef(name: single)]
        }

        let album = (try? c.decodeIfPresent(AlbumRef.self, forKey: .album)) ?? nil

        // duration_seconds (Int) wins, then "duration"/"length" strings, then lengthSeconds.
        var seconds = (try? c.decodeIfPresent(Int.self, forKey: .duration_seconds)) ?? nil
        let durationString =
            (try? c.decodeIfPresent(String.self, forKey: .duration))
            ?? (try? c.decodeIfPresent(String.self, forKey: .length)) ?? nil
        if seconds == nil {
            seconds = (try? c.decodeIfPresent(Int.self, forKey: .lengthSeconds)) ?? nil
        }
        if seconds == nil { seconds = parseDurationSeconds(durationString) }

        let label = durationString ?? formatDuration(seconds)

        let payloadThumbs = (try? c.decodeIfPresent([Thumbnail].self, forKey: .thumbnails)) ?? nil
        let singleThumb = (try? c.decodeIfPresent([Thumbnail].self, forKey: .thumbnail)) ?? nil
        let artworkObject = (try? c.decodeIfPresent([Thumbnail].self, forKey: .artwork)) ?? nil

        self.init(
            videoId: videoId,
            title: title.isEmpty ? "Unknown title" : title,
            artists: artists,
            album: album,
            durationLabel: label,
            durationSeconds: seconds,
            artwork: cdnArtwork(videoId) ?? pickArtwork(payloadThumbs, singleThumb, artworkObject),
            artworkAlt: pickArtwork(payloadThumbs, singleThumb, artworkObject),
            year: (try? c.decodeIfPresent(String.self, forKey: .year)) ?? nil,
            isExplicit: (try? c.decodeIfPresent(Bool.self, forKey: .isExplicit)) ?? false,
            playlistId: (try? c.decodeIfPresent(String.self, forKey: .playlistId)) ?? nil
        )
    }

    /// Explicit because the CodingKeys carry payload-only names (`duration`,
    /// `thumbnails`, …) that match no stored property — synthesis won't run.
    /// Keys mirror what `init(from:)` reads so the persisted queue round-trips.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(videoId, forKey: .videoId)
        try c.encode(title, forKey: .title)
        try c.encode(artists, forKey: .artists)
        try c.encodeIfPresent(album, forKey: .album)
        try c.encodeIfPresent(durationLabel, forKey: .duration)
        try c.encodeIfPresent(durationSeconds, forKey: .duration_seconds)
        try c.encodeIfPresent(year, forKey: .year)
        try c.encode(isExplicit, forKey: .isExplicit)
        try c.encodeIfPresent(playlistId, forKey: .playlistId)
        // Primary art is recomputed from videoId on decode; keep the fallback.
        if let artworkAlt {
            try c.encode(
                [Thumbnail(url: artworkAlt, width: nil, height: nil)],
                forKey: .thumbnails
            )
        }
    }
}

// MARK: - Cards (home rows, search results, shelves)

/// What a card points at — drives both tap handling and tile art.
enum CardKind: String, Codable, Sendable {
    case song, album, artist, playlist, station, unsupported
}

/// Any heterogeneous API item: a song, album, artist, playlist or radio card
/// from `/browsing/home`, `/search` or an artist shelf.
struct MediaCard: Decodable, Hashable, Identifiable, Sendable {
    var id: String
    var kind: CardKind
    var title: String
    /// Artist line / playlist author / card description — whatever the payload gave.
    var subtitle: String
    /// videoId (song), browseId (album/artist), playlist id (playlist/station).
    var targetId: String
    /// Fully normalized track for `.song` cards — what "play" needs.
    var track: Track?
    var artwork: String?
    var artworkAlt: String?
    var itemCount: Int?
    var year: String?
    var isExplicit: Bool
    /// The API's grouping label ("Top result", "Songs", …) — search sections.
    var category: String?

    private enum CodingKeys: String, CodingKey {
        case videoId, browseId, playlistId, radioId, shuffleId, title, artists, artist, author
        case description, resultType, type, itemCount, thumbnails, thumbnail, artwork
        case isExplicit, year, category, duration, duration_seconds, length, owned
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)

        let videoId = (try? c.decodeIfPresent(String.self, forKey: .videoId)) ?? nil
        let browseId = (try? c.decodeIfPresent(String.self, forKey: .browseId)) ?? nil
        let playlistId = (try? c.decodeIfPresent(String.self, forKey: .playlistId)) ?? nil
        let radioId = (try? c.decodeIfPresent(String.self, forKey: .radioId)) ?? nil
        let resultType = (try? c.decodeIfPresent(String.self, forKey: .resultType)) ?? nil
        let title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        let description = (try? c.decodeIfPresent(String.self, forKey: .description)) ?? nil

        var artists = (try? c.decodeIfPresent([ArtistRef].self, forKey: .artists)) ?? []
        if artists.isEmpty, let single = (try? c.decodeIfPresent(String.self, forKey: .artist)), !single.isEmpty {
            artists = [ArtistRef(name: single)]
        }
        let author = (try? c.decodeIfPresent(String.self, forKey: .author)) ?? nil
        let artistLine = artists.map(\.name).filter { !$0.isEmpty }.joined(separator: ", ")

        // Kind: explicit resultType first, then id-prefix heuristics (home rows
        // carry no resultType at all).
        let kind: CardKind
        switch resultType {
        case "podcast", "episode":
            kind = .unsupported
        case "song", "video":
            kind = videoId != nil ? .song : .unsupported
        case "album":
            kind = .album
        case "artist":
            kind = .artist
        case "playlist":
            kind = playlistId?.hasPrefix("RD") == true || (browseId?.hasPrefix("VLRD") ?? false) ? .station : .playlist
        default:
            if let browseId, browseId.hasPrefix("MPRE") {
                kind = .album
            } else if let playlistId, playlistId.hasPrefix("RD") {
                kind = .station
            } else if videoId != nil {
                kind = .song
            } else if let browseId, browseId.hasPrefix("UC") {
                kind = .artist
            } else if playlistId != nil || (browseId?.hasPrefix("VL") ?? false) {
                kind = .playlist
            } else {
                kind = .unsupported
            }
        }

        // Target id per kind. Playlist browse ids arrive as `VL<id>`.
        let targetId: String
        switch kind {
        case .song:
            targetId = videoId ?? ""
        case .album:
            targetId = browseId ?? ""
        case .artist:
            targetId = browseId ?? ""
        case .playlist, .station:
            if let playlistId {
                targetId = playlistId
            } else if let browseId, browseId.hasPrefix("VL") {
                targetId = String(browseId.dropFirst(2))
            } else {
                targetId = browseId ?? radioId ?? ""
            }
        case .unsupported:
            targetId = videoId ?? browseId ?? playlistId ?? ""
        }

        let subtitle: String
        switch kind {
        case .song, .album:
            subtitle = artistLine
        case .artist:
            subtitle = "Artist"
        case .playlist, .station:
            subtitle = author ?? artistLine
        case .unsupported:
            subtitle = description ?? author ?? artistLine
        }

        let track: Track? = kind == .song ? (try? Track(from: decoder)) : nil

        let payloadThumbs = (try? c.decodeIfPresent([Thumbnail].self, forKey: .thumbnails)) ?? nil
        let singleThumb = (try? c.decodeIfPresent([Thumbnail].self, forKey: .thumbnail)) ?? nil
        let artworkObject = (try? c.decodeIfPresent([Thumbnail].self, forKey: .artwork)) ?? nil
        let primary = kind == .song ? (cdnArtwork(videoId) ?? pickArtwork(payloadThumbs)) : pickArtwork(payloadThumbs)

        self.id = "\(kind.rawValue):\(targetId.isEmpty ? title : targetId)"
        self.kind = kind
        self.title = title
        self.subtitle = subtitle
        self.targetId = targetId
        self.track = track
        self.artwork = primary
        self.artworkAlt = pickArtwork(payloadThumbs, singleThumb, artworkObject)
        self.itemCount = (try? c.decodeIfPresent(Int.self, forKey: .itemCount)) ?? nil
        self.year = (try? c.decodeIfPresent(String.self, forKey: .year)) ?? nil
        self.isExplicit = (try? c.decodeIfPresent(Bool.self, forKey: .isExplicit)) ?? false
        self.category = (try? c.decodeIfPresent(String.self, forKey: .category)) ?? nil
    }
}

// MARK: - Endpoint payloads

/// A shelf: either a plain array or `{results: [...]}` (artist pages).
struct Shelf<T: Decodable>: Decodable, Sendable where T: Sendable {
    var results: [T]

    init(from decoder: Decoder) throws {
        if let array = (try? decoder.singleValueContainer().decode([Failable<T>].self)) {
            results = array.compactMap(\.value)
            return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        results = c.decodeSkippingFailures(T.self, forKey: .results)
    }

    private enum CodingKeys: String, CodingKey { case results }
}

/// One row of `/browsing/home`: `{title, contents: [cards]}`.
struct HomeSection: Decodable, Hashable, Identifiable, Sendable {
    var title: String
    var contents: [MediaCard]

    var id: String { title }

    private enum CodingKeys: String, CodingKey { case title, contents, items }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        contents = c.decodeSkippingFailures(MediaCard.self, forKey: .contents)
        if contents.isEmpty { contents = c.decodeSkippingFailures(MediaCard.self, forKey: .items) }
    }
}

/// `/browsing/album/{MPRE…}`.
struct AlbumDetail: Decodable, Sendable {
    var title: String
    var artists: [ArtistRef]
    var author: String?
    var year: String?
    var description: String?
    var thumbnails: [Thumbnail]?
    var thumbnail: [Thumbnail]?
    var trackCount: Int?
    var duration: String?
    var tracks: [Track]

    private enum CodingKeys: String, CodingKey {
        case title, artists, author, year, description, thumbnails, thumbnail
        case trackCount, duration, tracks, items
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        artists = (try? c.decodeIfPresent([ArtistRef].self, forKey: .artists)) ?? []
        author = (try? c.decodeIfPresent(String.self, forKey: .author)) ?? nil
        year = (try? c.decodeIfPresent(String.self, forKey: .year)) ?? nil
        description = (try? c.decodeIfPresent(String.self, forKey: .description)) ?? nil
        thumbnails = (try? c.decodeIfPresent([Thumbnail].self, forKey: .thumbnails)) ?? nil
        thumbnail = (try? c.decodeIfPresent([Thumbnail].self, forKey: .thumbnail)) ?? nil
        trackCount = (try? c.decodeIfPresent(Int.self, forKey: .trackCount)) ?? nil
        duration = (try? c.decodeIfPresent(String.self, forKey: .duration)) ?? nil
        tracks = c.decodeSkippingFailures(Track.self, forKey: .tracks)
        if tracks.isEmpty { tracks = c.decodeSkippingFailures(Track.self, forKey: .items) }
    }

    var artistLine: String {
        let names = artists.map(\.name).filter { !$0.isEmpty }.joined(separator: ", ")
        if !names.isEmpty { return names }
        return author ?? ""
    }

    var artworkURL: String? { pickArtwork(thumbnails, thumbnail) }
}

/// `/playlists/{playlistId}`.
struct PlaylistDetail: Decodable, Sendable {
    var id: String?
    var title: String
    var author: String?
    var description: String?
    var thumbnails: [Thumbnail]?
    var trackCount: Int?
    var tracks: [Track]

    private enum CodingKeys: String, CodingKey {
        case id, title, author, description, thumbnails, trackCount, tracks, items
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? nil
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        author = (try? c.decodeIfPresent(String.self, forKey: .author)) ?? nil
        description = (try? c.decodeIfPresent(String.self, forKey: .description)) ?? nil
        thumbnails = (try? c.decodeIfPresent([Thumbnail].self, forKey: .thumbnails)) ?? nil
        trackCount = (try? c.decodeIfPresent(Int.self, forKey: .trackCount)) ?? nil
        tracks = c.decodeSkippingFailures(Track.self, forKey: .tracks)
        if tracks.isEmpty { tracks = c.decodeSkippingFailures(Track.self, forKey: .items) }
    }

    var artworkURL: String? { pickArtwork(thumbnails) }
}

/// `/browsing/artist/{UC…}`.
struct ArtistDetail: Decodable, Sendable {
    var name: String
    var description: String?
    var thumbnails: [Thumbnail]?
    var subscribers: String?
    var monthlyListeners: String?
    var views: String?
    var songs: [Track]
    var albums: [MediaCard]
    var singles: [MediaCard]
    var related: [MediaCard]

    private enum CodingKeys: String, CodingKey {
        case name, description, thumbnails, subscribers, monthlyListeners, views
        case songs, albums, singles, related
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        description = (try? c.decodeIfPresent(String.self, forKey: .description)) ?? nil
        thumbnails = (try? c.decodeIfPresent([Thumbnail].self, forKey: .thumbnails)) ?? nil
        subscribers = (try? c.decodeIfPresent(String.self, forKey: .subscribers)) ?? nil
        monthlyListeners = (try? c.decodeIfPresent(String.self, forKey: .monthlyListeners)) ?? nil
        views = (try? c.decodeIfPresent(String.self, forKey: .views)) ?? nil
        songs = ((try? c.decodeIfPresent(Shelf<Track>.self, forKey: .songs)) ?? nil)?.results ?? []
        albums = ((try? c.decodeIfPresent(Shelf<MediaCard>.self, forKey: .albums)) ?? nil)?.results ?? []
        singles = ((try? c.decodeIfPresent(Shelf<MediaCard>.self, forKey: .singles)) ?? nil)?.results ?? []
        related = ((try? c.decodeIfPresent(Shelf<MediaCard>.self, forKey: .related)) ?? nil)?.results ?? []
    }

    var artworkURL: String? { pickArtwork(thumbnails) }
}

/// `/browsing/related/{videoId}` and `/watch` — both answer `{tracks: [...]}`.
struct TrackListPayload: Decodable, Sendable {
    var tracks: [Track]

    private enum CodingKeys: String, CodingKey { case tracks }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tracks = c.decodeSkippingFailures(Track.self, forKey: .tracks)
    }
}

/// Enriched `/browsing/track/{videoId}` — metadata **and** lyrics in one call.
/// Flat on the wire: the track's own fields sit at the root next to `lyrics`,
/// so encoding mirrors decoding (this is also the offline `track.json`).
struct TrackDetail: Codable, Sendable {
    var track: Track
    var lyrics: Lyrics?
    var genre: String?
    var description: String?

    init(from decoder: Decoder) throws {
        track = try Track(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        lyrics = (try? c.decodeIfPresent(Lyrics.self, forKey: .lyrics)) ?? nil
        genre = (try? c.decodeIfPresent(String.self, forKey: .genre)) ?? nil
        description = (try? c.decodeIfPresent(String.self, forKey: .description)) ?? nil
    }

    private enum CodingKeys: String, CodingKey { case lyrics, genre, description }

    /// `Track.encode(to:)` requests the root container with its own keys, then
    /// the extras are written beside them — JSONEncoder shares one storage for
    /// both requests, exactly like `init(from:)` reads it.
    func encode(to encoder: Encoder) throws {
        try track.encode(to: encoder)
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(lyrics, forKey: .lyrics)
        try container.encodeIfPresent(genre, forKey: .genre)
        try container.encodeIfPresent(description, forKey: .description)
    }
}
