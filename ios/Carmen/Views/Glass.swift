//
//  Glass.swift
//  Carmen — Liquid Glass (iOS 26+) surfaces with material fallbacks (iOS 18–25).
//
//  The app targets iOS 18, so every glass call site goes through these
//  wrappers: on iOS 26 the system renders true Liquid Glass (refraction,
//  specular highlight, interactive warp), below it a material that keeps the
//  same visual hierarchy. System surfaces — tab bar, navigation bars, sheets
//  — pick up Liquid Glass automatically on iOS 26 without any code here.
//

import SwiftUI

extension View {
    /// Rounded glass card behind a custom surface (mini player, tiles, banners).
    /// @ViewBuilder: the iOS 26 / fallback branches are different types.
    @ViewBuilder
    func glassCard(cornerRadius: CGFloat = 16) -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(.regular, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        } else {
            background(.thinMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        }
    }

    /// Pill-shaped glass (chips, transport clusters).
    @ViewBuilder
    func glassCapsule() -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(.regular, in: Capsule())
        } else {
            background(.thinMaterial, in: Capsule())
        }
    }

    /// Glass that lets photography show through with refraction only.
    @ViewBuilder
    func clearGlassCard(cornerRadius: CGFloat = 16) -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(.clear, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        } else {
            background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        }
    }

    /// Background for a small icon button cluster floating over content.
    @ViewBuilder
    func glassToolbarCapsule() -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(.regular, in: Capsule())
        } else {
            background(.regularMaterial, in: Capsule())
        }
    }
}

/// Prominent (tinted) glass action button — `.glassProminent` on iOS 26,
/// `.borderedProminent` below it. Whole-Button branching keeps both styles
/// type-checked against their own SDK gates.
struct GlassPrimaryButton<Label: View>: View {
    let action: () -> Void
    let label: Label

    init(action: @escaping () -> Void, @ViewBuilder label: () -> Label) {
        self.action = action
        self.label = label()
    }

    var body: some View {
        if #available(iOS 26.0, *) {
            Button(action: action, label: { label })
                .buttonStyle(.glassProminent)
        } else {
            Button(action: action, label: { label })
                .buttonStyle(.borderedProminent)
        }
    }
}

/// Plain glass action button — `.glass` on iOS 26, bordered below.
struct GlassPlainButton<Label: View>: View {
    let action: () -> Void
    let label: Label

    init(action: @escaping () -> Void, @ViewBuilder label: () -> Label) {
        self.action = action
        self.label = label()
    }

    var body: some View {
        if #available(iOS 26.0, *) {
            Button(action: action, label: { label })
                .buttonStyle(.glass)
        } else {
            Button(action: action, label: { label })
                .buttonStyle(.bordered)
        }
    }
}
