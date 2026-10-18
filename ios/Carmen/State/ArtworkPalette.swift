//
//  ArtworkPalette.swift
//  Carmen — the cover's own colour, read out of its pixels.
//
//  A straight port of the web client's `theme/color.ts` (pickAccentColor) so
//  both clients theme alike:
//
//   1. Only the 1:1 cover counts — the image is downsampled to 48×48 first.
//   2. A cover that carries no colour is black → white.
//   3. The record's hue wins, not its shadows — coloured pixels are tallied
//      by hue sector, each weighted by area × chroma.
//   4. An accent has to be visible — nearly-black winners are lifted, washed
//      out pastels are pulled down; the hue survives either way.
//
//  The result feeds `Player.adaptiveColor`, which `Color.carmen` falls back
//  to when Settings → Appearance → Adaptive Accent is on.
//

import UIKit

enum ArtworkPalette {
    /// Bytes per pixel of the RGBA buffer.
    private static let bytesPerPixel = 4
    /// Pixels at or above this alpha are cover; below it is background.
    private static let minAlpha = 200
    /// `max - min` channel spread at which a pixel counts as coloured.
    private static let chromaMin = 24
    /// Below this share of coloured pixels the cover reads as black/grey.
    private static let colorfulMin = 0.12
    /// Bucket granularity: the top 4 bits of each channel → 4096 buckets.
    private static let bucketShift = 4
    /// Hue is tallied in sectors of this many degrees (12 in a full turn).
    private static let hueSectorDegrees = 30.0
    /// Weight of the pixel count against the weight of the colour.
    private static let massFloor = 0.2
    /// A winner darker than this lightness is not readable as an accent.
    private static let minLightness = 0.34
    /// A winner greyer than this is a shade of grey, not a colour.
    private static let minSaturation = 0.16
    /// Dark covers are lifted here (lightness) with at least this saturation.
    private static let liftedLightness = 0.55
    private static let liftedSaturation = 0.5
    /// Pale covers are pulled down to this lightness instead.
    private static let maxLightness = 0.6
    /// What a cover with no colour in it answers.
    private static let neutralAccent = "#FFFFFF"

    private struct Bucket {
        var count = 0
        var r = 0.0
        var g = 0.0
        var b = 0.0
    }

    private struct Sector {
        var score = 0.0
        var winner: (r: Double, g: Double, b: Double)
        var winnerScore = 0.0

        init(score: Double, winner: (r: Double, g: Double, b: Double)) {
            self.score = score
            self.winner = winner
            self.winnerScore = score
        }
    }

    /// Accent hex ("#RRGGBB") for an artwork image, or nil when it carries
    /// nothing readable. Cheap enough to run on every track change: the image
    /// is downscaled to 48×48 before a single pixel is looked at.
    static func accentHex(of image: UIImage) -> String? {
        guard let rgba = sampleRGBA(of: image), !rgba.isEmpty else { return nil }

        var buckets: [Int: Bucket] = [:]
        var total = 0
        var colored = 0

        var index = 0
        while index + bytesPerPixel <= rgba.count {
            if rgba[index + 3] >= minAlpha {
                let r = Double(rgba[index])
                let g = Double(rgba[index + 1])
                let b = Double(rgba[index + 2])
                total += 1
                if chroma(r, g, b) >= chromaMin { colored += 1 }

                let key =
                    (Int(rgba[index]) >> bucketShift) * 256
                    + (Int(rgba[index + 1]) >> bucketShift) * 16
                    + (Int(rgba[index + 2]) >> bucketShift)
                if var bucket = buckets[key] {
                    bucket.count += 1
                    bucket.r += r
                    bucket.g += g
                    bucket.b += b
                    buckets[key] = bucket
                } else {
                    buckets[key] = Bucket(count: 1, r: r, g: g, b: b)
                }
            }
            index += bytesPerPixel
        }

        guard total > 0 else { return nil }

        // Rule 2: black / grey cover → white.
        guard Double(colored) / Double(total) >= colorfulMin else { return neutralAccent }

        // Rule 3: tally the coloured buckets by hue sector. Shadows (chroma
        // below the floor) cast no vote at all — they are lighting, not the
        // colour of the record.
        var sectors: [Int: Sector] = [:]
        for bucket in buckets.values {
            let r = bucket.r / Double(bucket.count)
            let g = bucket.g / Double(bucket.count)
            let b = bucket.b / Double(bucket.count)
            let spread = chroma(r, g, b)
            guard spread >= chromaMin else { continue }

            let score = Double(bucket.count) * (massFloor + spread / 255)
            let hue = rgbToHsl(r, g, b).hue
            let key = Int(hue / hueSectorDegrees)
            if var sector = sectors[key] {
                sector.score += score
                // The sector's own colour is its strongest voice, not its
                // biggest — the deepest shadow of a red wall is not the red.
                if score > sector.winnerScore {
                    sector.winnerScore = score
                    sector.winner = (r, g, b)
                }
                sectors[key] = sector
            } else {
                sectors[key] = Sector(score: score, winner: (r, g, b))
            }
        }

        guard !sectors.isEmpty else { return neutralAccent }

        var winner: (r: Double, g: Double, b: Double)?
        var bestScore = -1.0
        for sector in sectors.values where sector.score > bestScore {
            bestScore = sector.score
            winner = sector.winner
        }
        guard let picked = winner else { return nil }

        // Rule 4: readable, and still the cover's own colour.
        let hsl = rgbToHsl(picked.r, picked.g, picked.b)
        if hsl.lightness < minLightness {
            guard hsl.saturation >= minSaturation else { return neutralAccent }
            return hex(hslToRgb(hsl.hue, max(hsl.saturation, liftedSaturation), liftedLightness))
        }
        if hsl.lightness > maxLightness {
            guard hsl.saturation >= minSaturation else { return neutralAccent }
            return hex(hslToRgb(hsl.hue, hsl.saturation, maxLightness))
        }
        return hex(picked)
    }

    // MARK: - Sampling

    /// The image drawn into a 48×48 RGBA buffer — the same square the UI
    /// draws, cheap enough to run per track change.
    private static func sampleRGBA(of image: UIImage) -> [UInt8]? {
        let side = 48
        let size = CGSize(width: side, height: side)
        let renderer = UIGraphicsImageRenderer(size: size)
        let small = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        guard let cg = small.cgImage else { return nil }
        var pixels = [UInt8](repeating: 0, count: side * side * bytesPerPixel)
        guard
            let context = CGContext(
                data: &pixels,
                width: side,
                height: side,
                bitsPerComponent: 8,
                bytesPerRow: side * bytesPerPixel,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        else { return nil }
        context.draw(cg, in: CGRect(origin: .zero, size: size))
        return pixels
    }

    // MARK: - Colour maths

    private static func chroma(_ r: Double, _ g: Double, _ b: Double) -> Double {
        max(r, g, b) - min(r, g, b)
    }

    /// sRGB → HSL. Hue in 0–360; saturation / lightness in 0–1.
    private static func rgbToHsl(_ r: Double, _ g: Double, _ b: Double) -> (
        hue: Double, saturation: Double, lightness: Double
    ) {
        let rn = r / 255, gn = g / 255, bn = b / 255
        let maxChannel = max(rn, gn, bn)
        let minChannel = min(rn, gn, bn)
        let lightness = (maxChannel + minChannel) / 2
        let delta = maxChannel - minChannel

        if delta == 0 { return (0, 0, lightness) }

        let saturation =
            delta / (lightness > 0.5 ? 2 - maxChannel - minChannel : maxChannel + minChannel)
        let hue: Double
        if maxChannel == rn {
            hue = ((gn - bn) / delta).truncatingRemainder(dividingBy: 6)
        } else if maxChannel == gn {
            hue = (bn - rn) / delta + 2
        } else {
            hue = (rn - gn) / delta + 4
        }
        return ((hue * 60 + 360).truncatingRemainder(dividingBy: 360), saturation, lightness)
    }

    /// HSL → sRGB bytes.
    private static func hslToRgb(_ hue: Double, _ saturation: Double, _ lightness: Double) -> (
        r: Double, g: Double, b: Double
    ) {
        let c = (1 - abs(2 * lightness - 1)) * saturation
        let sector = (((hue.truncatingRemainder(dividingBy: 360)) + 360)
            .truncatingRemainder(dividingBy: 360)) / 60
        let x = c * (1 - abs((sector.truncatingRemainder(dividingBy: 2)) - 1))
        let rgb: (Double, Double, Double)
        switch sector {
        case ..<1: rgb = (c, x, 0)
        case ..<2: rgb = (x, c, 0)
        case ..<3: rgb = (0, c, x)
        case ..<4: rgb = (0, x, c)
        case ..<5: rgb = (x, 0, c)
        default: rgb = (c, 0, x)
        }
        let m = lightness - c / 2
        func byte(_ value: Double) -> Double {
            min(255, max(0, ((value + m) * 255).rounded()))
        }
        return (byte(rgb.0), byte(rgb.1), byte(rgb.2))
    }

    private static func hex(_ rgb: (r: Double, g: Double, b: Double)) -> String {
        String(format: "#%02X%02X%02X", Int(rgb.r), Int(rgb.g), Int(rgb.b))
    }
}
