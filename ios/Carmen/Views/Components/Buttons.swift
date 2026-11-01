//
//  Buttons.swift
//  Carmen — Material 3 button styles.
//
//  M3 spec: filled / tonal / text buttons are 40pt-tall capsules with a 24pt
//  horizontal inset; icon buttons are 40pt circles with a 14% primary ripple
//  when pressed. Filled defaults to the scheme's primary, but every style
//  takes an optional `fill` so screens can paint the *live accent* (the
//  artwork-derived Color.carmen) instead — Android lets its seed flow into
//  every filled surface, this is the iOS equivalent.
//

import SwiftUI

// MARK: - Filled (primary) — the "Play" button, primary actions

struct M3FilledStyle: ButtonStyle {
    @Environment(\.m3) private var m3

    /// nil → scheme primary; pass `.carmen` to follow the live accent.
    var fill: Color? = nil
    var foreground: Color? = nil
    var compact: Bool = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.m3LabelLarge)
            .padding(.horizontal, compact ? 14 : 24)
            .frame(minHeight: 40)
            .frame(maxWidth: .infinity)
            .background(fill ?? m3.primary, in: M3Shape.capsule)
            .foregroundStyle(foreground ?? m3.onPrimary)
            .opacity(configuration.isPressed ? 0.86 : 1)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

// MARK: - Tonal (secondary container) — the second-choice action

struct M3TonalStyle: ButtonStyle {
    @Environment(\.m3) private var m3

    var fill: Color? = nil
    var foreground: Color? = nil
    var compact: Bool = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.m3LabelLarge)
            .padding(.horizontal, compact ? 14 : 24)
            .frame(minHeight: 40)
            .frame(maxWidth: .infinity)
            .background(fill ?? m3.secondaryContainer, in: M3Shape.capsule)
            .foregroundStyle(foreground ?? m3.onSecondaryContainer)
            .opacity(configuration.isPressed ? 0.86 : 1)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

// MARK: - Text — quiet actions ("Play all", "See all")

struct M3TextStyle: ButtonStyle {
    @Environment(\.m3) private var m3

    var fill: Color? = nil
    var compact: Bool = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.m3LabelLarge)
            .padding(.horizontal, compact ? 8 : 12)
            .frame(minHeight: 40)
            .background(
                configuration.isPressed ? (fill ?? m3.primary).opacity(0.14) : .clear,
                in: M3Shape.capsule
            )
            .foregroundStyle(fill ?? m3.primary)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

// MARK: - Icon — 40pt circle (kebab, close, transport)

struct M3IconButtonStyle: ButtonStyle {
    @Environment(\.m3) private var m3

    var fill: Color? = nil
    var foreground: Color? = nil

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(width: 40, height: 40)
            .background(
                configuration.isPressed ? (fill ?? m3.primary).opacity(0.14) : .clear,
                in: Circle()
            )
            .foregroundStyle(foreground ?? m3.onSurfaceVariant)
            .scaleEffect(configuration.isPressed ? 0.92 : 1)
            .animation(.spring(response: 0.24, dampingFraction: 0.65), value: configuration.isPressed)
    }
}

// MARK: - Floating action button (Android's FAB / extended FAB)

/// 56pt filled FAB. Pass `title` for the extended variant ("Shuffle").
struct M3Fab: View {
    var systemImage: String = "shuffle"
    var title: String? = nil
    var fill: Color? = nil
    var foreground: Color? = nil
    var action: () -> Void

    @Environment(\.m3) private var m3

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: systemImage)
                    .font(.system(size: 20, weight: .semibold))
                if let title {
                    Text(title)
                        .font(.m3LabelLarge)
                }
            }
            .foregroundStyle(foreground ?? m3.onPrimary)
            .padding(.horizontal, title == nil ? 16 : 20)
            .frame(height: M3Dim.fab)
            .frame(minWidth: title == nil ? M3Dim.fab : nil)
            .background(fill ?? m3.primary, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .shadow(color: m3.scrim.opacity(0.28), radius: 6, y: 3)
        }
        .buttonStyle(.plain)
        .pressScale(0.95)
    }
}
