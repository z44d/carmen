//
//  Surfaces.swift
//  Carmen — Material cards, shimmer skeletons and the loading/error/empty
//  panes every screen composes its states from.
//

import SwiftUI

// MARK: - Card

/// Material card: surface-container fill, 12dp radius, optional tap.
/// Content provides its own padding so dense rows can opt out.
struct M3Card<Content: View>: View {
    var padding: CGFloat = 16
    var fill: Color? = nil
    var action: (() -> Void)? = nil
    private let content: () -> Content

    @Environment(\.m3) private var m3

    init(
        padding: CGFloat = 16,
        fill: Color? = nil,
        action: (() -> Void)? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.padding = padding
        self.fill = fill
        self.action = action
        self.content = content
    }

    var body: some View {
        Group {
            if let action {
                Button(action: action) { inner }
                    .buttonStyle(.plain)
            } else {
                inner
            }
        }
    }

    private var inner: some View {
        content()
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(fill ?? m3.surfaceContainer, in: M3Shape.card)
            .contentShape(M3Shape.card)
    }
}

// MARK: - Shimmer

/// The Android shimmer sweep — a soft highlight crossing the placeholder.
private struct ShimmerModifier: ViewModifier {
    @State private var move = false

    func body(content: Content) -> some View {
        content
            .overlay {
                GeometryReader { proxy in
                    let width = max(proxy.size.width, 1)
                    LinearGradient(
                        colors: [.clear, Color.white.opacity(0.38), .clear],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                    .frame(width: width * 0.55)
                    .offset(x: move ? width * 1.1 : -width * 0.6)
                }
            }
            .mask { Rectangle() }
            .onAppear {
                withAnimation(.linear(duration: 1.1).repeatForever(autoreverses: false)) {
                    move = true
                }
            }
    }
}

extension View {
    /// Adds the sweeping shimmer to any placeholder shape.
    func shimmering() -> some View { modifier(ShimmerModifier()) }
}

/// A single shimmering placeholder block.
struct ShimmerBlock: View {
    var height: CGFloat = 12
    var radius: CGFloat = 6

    @Environment(\.m3) private var m3

    var body: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(m3.surfaceContainerHighest)
            .frame(height: height)
            .shimmering()
    }
}

/// Skeleton shaped like a run of `ListRow`s — shown while a list loads.
struct ShimmerList: View {
    var rows: Int = 6

    @Environment(\.m3) private var m3

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<rows, id: \.self) { _ in
                HStack(spacing: 12) {
                    ShimmerBlock(height: M3Dim.listThumb, radius: 10)
                        .frame(width: M3Dim.listThumb)
                    VStack(alignment: .leading, spacing: 8) {
                        ShimmerBlock(height: 14)
                        ShimmerBlock(height: 12, radius: 5)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 16)
                .frame(height: M3Dim.listHeight)
            }
        }
    }
}

/// Skeleton shaped like a run of `GridTile`s — shown while a feed loads.
struct ShimmerGrid: View {
    var items: Int = 6
    var columns: Int = 2

    @Environment(\.m3) private var m3

    private var layout: [GridItem] {
        Array(repeating: GridItem(.flexible(), spacing: 16), count: columns)
    }

    var body: some View {
        LazyVGrid(columns: layout, spacing: 20) {
            ForEach(0..<items, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 8) {
                    ShimmerBlock(height: 150, radius: 8)
                    ShimmerBlock(height: 14)
                    ShimmerBlock(height: 12, radius: 5)
                }
            }
        }
    }
}

// MARK: - States

/// Centered spinner + label (replaces the old `LoadingState`).
struct M3LoadingState: View {
    var label: String = "Loading…"

    @Environment(\.m3) private var m3

    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
                .tint(m3.primary)
            Text(label)
                .font(.m3BodyMedium)
                .foregroundStyle(m3.onSurfaceVariant)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 60)
    }
}

/// Failure pane with an optional retry (replaces the old `ErrorState`).
struct M3ErrorState: View {
    var message: String
    var retry: (() -> Void)? = nil

    @Environment(\.m3) private var m3

    var body: some View {
        VStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(m3.error.opacity(0.12))
                    .frame(width: 64, height: 64)
                Image(systemName: "wifi.exclamationmark")
                    .font(.system(size: 26, weight: .medium))
                    .foregroundStyle(m3.error)
            }
            Text("Something went wrong")
                .font(.m3TitleMedium)
                .foregroundStyle(m3.onSurface)
            Text(message)
                .font(.m3BodyMedium)
                .foregroundStyle(m3.onSurfaceVariant)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
            if let retry {
                Button("Try Again", action: retry)
                    .buttonStyle(M3FilledStyle(compact: true))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 48)
    }
}

/// Empty pane with an icon badge (replaces the old `EmptyState`).
struct M3EmptyState: View {
    var title: String
    var hint: String? = nil
    var systemImage: String = "tray"

    @Environment(\.m3) private var m3

    var body: some View {
        VStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(m3.primaryContainer)
                    .frame(width: 64, height: 64)
                Image(systemName: systemImage)
                    .font(.system(size: 26, weight: .medium))
                    .foregroundStyle(m3.onPrimaryContainer)
            }
            Text(title)
                .font(.m3TitleMedium)
                .foregroundStyle(m3.onSurface)
                .multilineTextAlignment(.center)
            if let hint {
                Text(hint)
                    .font(.m3BodyMedium)
                    .foregroundStyle(m3.onSurfaceVariant)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 40)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 48)
    }
}
