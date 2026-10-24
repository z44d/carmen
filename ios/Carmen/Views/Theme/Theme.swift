//
//  Theme.swift
//  Carmen — Material 3 design tokens.
//
//  The Android app seeds its scheme from Carmen's red-pink (0xFFED5564) but
//  lets the artwork-extracted accent win when Adaptive Accent is on. This
//  file keeps that same precedence and derives the full Material 3 role set
//  (light + dark) from whatever seed is live, so every surface re-tints the
//  moment a new cover's colour lands — exactly like Android's materialkolor
//  dynamic scheme, but hand-rolled (no dependencies).
//
//  Usage in views:
//      @Environment(\.m3) private var m3      // color roles
//      Text("Title").font(.m3TitleLarge)      // Poppins type scale
//      .background(m3.surfaceContainer, in: M3Shape.card)
//
//  The root applies `.m3Theme()` (RootView) — nothing else injects roles.
//

import SwiftUI

// MARK: - Accent (moved verbatim from the old Components.swift)

extension Color {
    /// Hex string ("#RRGGBB") → Color.
    init(hex: String) {
        var value: UInt64 = 0
        Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&value)
        self.init(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255,
            opacity: 1
        )
    }

    /// The hex the whole app currently themes by: the playing cover's own
    /// colour when Settings → Appearance → Adaptive Accent is on (frontend
    /// parity), else the chosen palette accent.
    @MainActor fileprivate static var effectiveHex: String {
        let settings = SettingsStore.shared
        if settings.adaptiveAccentEnabled, let hex = Player.shared.adaptiveColorHex, !hex.isEmpty {
            return hex
        }
        return settings.accent.hex
    }

    /// The app-wide accent seed. Read through the observable stores so every
    /// surface re-renders live — including when the cover's colour lands
    /// mid-song.
    @MainActor static var carmen: Color { Color(hex: effectiveHex) }

    /// Ink for filled-accent surfaces (play button, FABs): stays readable on
    /// the near-white accents — the palette's "no colour here" answer too.
    @MainActor static var carmenOnAccent: Color {
        isNearWhite(effectiveHex) ? .black.opacity(0.85) : .white
    }

    /// Tint for system controls (switches, sliders, ProgressView): a white
    /// accent would draw them in white-on-white, so near-white accents flip
    /// to black ink there — same rule as the frontend gives white.
    @MainActor static var carmenControlTint: Color {
        isNearWhite(effectiveHex) ? .black : carmen
    }

    /// "#FFFFFF", "ffffff", "  #fefefe " … — all "close enough to white".
    private static func isNearWhite(_ hex: String) -> Bool {
        var value: UInt64 = 0
        Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&value)
        let red = (value >> 16) & 0xFF
        let green = (value >> 8) & 0xFF
        let blue = value & 0xFF
        return red >= 235 && green >= 235 && blue >= 235
    }
}

// MARK: - Seed

/// The live scheme seed. Mirrors `Color.carmen` precedence; kept separate so
/// non-view code (roles derivation) has one obvious entry point.
@MainActor enum M3 {
    /// Android's `DefaultThemeColor = 0xFFED5564` — used only when no accent
    /// can be resolved at all.
    static let fallbackSeedHex = "ED5564"

    static var seedHex: String { Color.effectiveHex }
}

// MARK: - HSL helpers

private struct HSL {
    var h: Double  // 0...360
    var s: Double  // 0...1
    var l: Double  // 0...1
}

private func hsl(_ hex: String) -> HSL {
    var value: UInt64 = 0
    Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&value)
    let r = Double((value >> 16) & 0xFF) / 255
    let g = Double((value >> 8) & 0xFF) / 255
    let b = Double(value & 0xFF) / 255
    let maxChannel = max(r, g, b)
    let minChannel = min(r, g, b)
    let lightness = (maxChannel + minChannel) / 2
    let delta = maxChannel - minChannel
    guard delta > 0.000_01 else { return HSL(h: 0, s: 0, l: lightness) }
    let saturation = delta / (1 - abs(2 * lightness - 1))
    let hue: Double
    if maxChannel == r {
        hue = 60 * ((g - b) / delta).truncatingRemainder(dividingBy: 6)
    } else if maxChannel == g {
        hue = 60 * ((b - r) / delta + 2)
    } else {
        hue = 60 * ((r - g) / delta + 4)
    }
    return HSL(h: hue < 0 ? hue + 360 : hue, s: saturation, l: lightness)
}

private func shifted(_ color: HSL, by degrees: Double) -> HSL {
    HSL(h: (color.h + degrees).truncatingRemainder(dividingBy: 360), s: color.s, l: color.l)
}

/// HSL → SwiftUI color (`opacity` reserved for the scrim-style roles).
private func tone(_ base: HSL, s: Double? = nil, l: Double? = nil, opacity: Double = 1) -> Color {
    let hue = base.h.truncatingRemainder(dividingBy: 360)
    let saturation = min(max(s ?? base.s, 0), 1)
    let lightness = min(max(l ?? base.l, 0), 1)
    let chroma = (1 - abs(2 * lightness - 1)) * saturation
    let x = chroma * (1 - abs((hue / 60).truncatingRemainder(dividingBy: 2) - 1))
    let m = lightness - chroma / 2
    var red = 0.0, green = 0.0, blue = 0.0
    switch hue {
    case ..<60: red = chroma; green = x
    case ..<120: red = x; green = chroma
    case ..<180: green = chroma; blue = x
    case ..<240: green = x; blue = chroma
    case ..<300: red = x; blue = chroma
    default: red = chroma; blue = x
    }
    return Color(
        .sRGB,
        red: red + m,
        green: green + m,
        blue: blue + m,
        opacity: opacity
    )
}

// MARK: - Color roles

/// The 19 Material 3 roles this app uses, derived from one seed for light
/// and dark. Naming follows the Material docs (surfaceContainerHigh …),
/// never raw hexes in screens.
struct M3Roles: Equatable {
    let seed: String

    let primary: Color
    let onPrimary: Color
    let primaryContainer: Color
    let onPrimaryContainer: Color

    let secondary: Color
    let onSecondary: Color
    let secondaryContainer: Color
    let onSecondaryContainer: Color

    let tertiary: Color
    let onTertiary: Color
    let tertiaryContainer: Color
    let onTertiaryContainer: Color

    let background: Color
    let surface: Color
    let surfaceContainer: Color
    let surfaceContainerHigh: Color
    let surfaceContainerHighest: Color

    let onSurface: Color
    let onSurfaceVariant: Color
    let outline: Color
    let outlineVariant: Color

    let error: Color
    let onError: Color
    let scrim: Color

    init(seedHex: String, dark: Bool) {
        let base = hsl(seedHex.isEmpty ? M3.fallbackSeedHex : seedHex)
        // A near-black seed would collapse the scheme to black-on-black; a
        // zero-saturation one (white/grey accents) falls back to Carmen pink.
        let seed = base.s < 0.08 && base.l < 0.12 ? hsl(M3.fallbackSeedHex) : base
        let strong = min(seed.s, 0.68)   // Material "primary" saturation cap
        self.seed = seedHex

        if dark {
            primary = tone(seed, s: strong, l: 0.70)
            onPrimary = tone(seed, s: strong, l: 0.18)
            primaryContainer = tone(seed, s: strong * 0.45, l: 0.28)
            onPrimaryContainer = tone(seed, s: strong * 0.60, l: 0.86)

            secondary = tone(seed, s: 0.22, l: 0.70)
            onSecondary = tone(seed, s: 0.22, l: 0.18)
            secondaryContainer = tone(seed, s: 0.22, l: 0.28)
            onSecondaryContainer = tone(seed, s: 0.26, l: 0.86)

            let ter = shifted(seed, by: 60)
            tertiary = tone(ter, s: 0.45, l: 0.70)
            onTertiary = tone(ter, s: 0.45, l: 0.18)
            tertiaryContainer = tone(ter, s: 0.30, l: 0.28)
            onTertiaryContainer = tone(ter, s: 0.45, l: 0.86)

            background = tone(seed, s: 0.05, l: 0.06)
            surface = tone(seed, s: 0.06, l: 0.10)
            surfaceContainer = tone(seed, s: 0.06, l: 0.14)
            surfaceContainerHigh = tone(seed, s: 0.06, l: 0.17)
            surfaceContainerHighest = tone(seed, s: 0.06, l: 0.20)

            onSurface = tone(seed, s: 0.07, l: 0.90)
            onSurfaceVariant = tone(seed, s: 0.06, l: 0.72)
            outline = tone(seed, s: 0.05, l: 0.52)
            outlineVariant = tone(seed, s: 0.05, l: 0.30)

            error = Color(hex: "F2B8B5")
            onError = Color(hex: "601410")
            scrim = .black
        } else {
            primary = tone(seed, s: strong, l: 0.45)
            onPrimary = .white
            primaryContainer = tone(seed, s: strong * 0.45, l: 0.90)
            onPrimaryContainer = tone(seed, s: strong, l: 0.15)

            secondary = tone(seed, s: 0.16, l: 0.42)
            onSecondary = .white
            secondaryContainer = tone(seed, s: 0.20, l: 0.88)
            onSecondaryContainer = tone(seed, s: 0.30, l: 0.15)

            let ter = shifted(seed, by: 60)
            tertiary = tone(ter, s: 0.45, l: 0.42)
            onTertiary = .white
            tertiaryContainer = tone(ter, s: 0.30, l: 0.90)
            onTertiaryContainer = tone(ter, s: 0.45, l: 0.15)

            background = tone(seed, s: 0.03, l: 0.99)
            surface = tone(seed, s: 0.03, l: 0.97)
            surfaceContainer = tone(seed, s: 0.04, l: 0.94)
            surfaceContainerHigh = tone(seed, s: 0.04, l: 0.92)
            surfaceContainerHighest = tone(seed, s: 0.04, l: 0.90)

            onSurface = tone(seed, s: 0.06, l: 0.11)
            onSurfaceVariant = tone(seed, s: 0.05, l: 0.32)
            outline = tone(seed, s: 0.05, l: 0.55)
            outlineVariant = tone(seed, s: 0.04, l: 0.82)

            error = Color(hex: "B3261E")
            onError = .white
            scrim = .black
        }
    }
}

// MARK: - Environment plumbing

private struct M3RolesKey: EnvironmentKey {
    static let defaultValue = M3Roles(seedHex: M3.fallbackSeedHex, dark: false)
}

extension EnvironmentValues {
    /// Current Material 3 color roles. Injected once by `.m3Theme()` in
    /// RootView; re-derived whenever the seed (live accent) or the system
    /// color scheme changes.
    var m3: M3Roles {
        get { self[M3RolesKey.self] }
        set { self[M3RolesKey.self] = newValue }
    }
}

struct M3ThemeModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        content.environment(\.m3, M3Roles(seedHex: M3.seedHex, dark: colorScheme == .dark))
    }
}

extension View {
    /// Applies the Material scheme at the app root. Everything below reads
    /// `@Environment(\.m3)`.
    func m3Theme() -> some View { modifier(M3ThemeModifier()) }
}

// MARK: - Shapes & dimensions

/// The M3 expressive shape scale (Android uses 8/12/16/24/32 dp).
enum M3Shape {
    static let small = RoundedRectangle(cornerRadius: 8, style: .continuous)
    static let card = RoundedRectangle(cornerRadius: 12, style: .continuous)
    static let sheet = RoundedRectangle(cornerRadius: 16, style: .continuous)
    static let dialog = RoundedRectangle(cornerRadius: 28, style: .continuous)
    static let large = RoundedRectangle(cornerRadius: 24, style: .continuous)
    static let pill = RoundedRectangle(cornerRadius: 32, style: .continuous)
    static let capsule = Capsule(style: .continuous)
}

/// Shared layout numbers — Android's `constants/Dimensions.kt`, in points.
enum M3Dim {
    static let listHeight: CGFloat = 72
    static let listThumb: CGFloat = 56
    static let gridThumb: CGFloat = 128
    static let appBar: CGFloat = 64
    static let navPill: CGFloat = 78
    static let miniPlayer: CGFloat = 70
    static let playerPad: CGFloat = 32
    static let chipHeight: CGFloat = 32
    static let fab: CGFloat = 56
}

// MARK: - Typography (Poppins)

/// Material's type scale mapped onto the bundled Poppins family (copied from
/// the Android app). `relativeTo` keeps Dynamic Type working — sizes grow
/// from the listed step with the user's text size.
extension Font {
    static func m3(_ size: CGFloat, weight: Font.Weight = .regular, relativeTo textStyle: Font.TextStyle = .body) -> Font {
        Font.custom("Poppins", size: size, relativeTo: textStyle).weight(weight)
    }

    static var m3DisplayLarge: Font { m3(57, relativeTo: .largeTitle) }
    static var m3HeadlineLarge: Font { m3(32, relativeTo: .title) }
    static var m3HeadlineMedium: Font { m3(28, relativeTo: .title) }
    static var m3TitleLarge: Font { m3(22, weight: .bold, relativeTo: .title2) }
    static var m3TitleMedium: Font { m3(16, weight: .medium, relativeTo: .headline) }
    static var m3TitleSmall: Font { m3(14, weight: .medium, relativeTo: .subheadline) }
    static var m3BodyLarge: Font { m3(16, relativeTo: .body) }
    static var m3BodyMedium: Font { m3(14, relativeTo: .subheadline) }
    static var m3BodySmall: Font { m3(12, relativeTo: .footnote) }
    static var m3LabelLarge: Font { m3(14, weight: .medium, relativeTo: .subheadline) }
    static var m3LabelMedium: Font { m3(12, weight: .medium, relativeTo: .footnote) }
    static var m3LabelSmall: Font { m3(11, weight: .medium, relativeTo: .caption2) }
}

// MARK: - Press feedback (chips & cards scale on touch, like Android's
// expressive spring)

private struct PressScaleModifier: ViewModifier {
    var scale: CGFloat = 0.96
    @State private var pressed = false

    func body(content: Content) -> some View {
        content
            .scaleEffect(pressed ? scale : 1)
            .animation(.spring(response: 0.28, dampingFraction: 0.62), value: pressed)
            .simultaneousGesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in pressed = true }
                    .onEnded { _ in pressed = false }
            )
    }
}

extension View {
    /// Android's item press-scale (expressive spring, ~4% shrink).
    func pressScale(_ scale: CGFloat = 0.96) -> some View {
        modifier(PressScaleModifier(scale: scale))
    }
}
