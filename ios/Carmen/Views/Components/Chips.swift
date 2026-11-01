//
//  Chips.swift
//  Carmen — Material 3 chips.
//
//  Android's search/library filter chips: 32pt capsules, outline at rest,
//  secondary-container fill + checkmark when selected, expressive spring
//  press-scale.
//

import SwiftUI

/// Selectable filter chip (search filters, sort options, home categories).
struct FilterChip: View {
    var isSelected: Bool
    var title: String
    var systemImage: String? = nil
    var action: () -> Void

    @Environment(\.m3) private var m3

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 14, weight: .semibold))
                }
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 14, weight: .medium))
                }
                Text(title)
                    .font(.m3LabelLarge)
                    .lineLimit(1)
            }
            .padding(.horizontal, 12)
            .frame(height: M3Dim.chipHeight)
            .foregroundStyle(isSelected ? m3.onSecondaryContainer : m3.onSurfaceVariant)
            .background(
                isSelected ? m3.secondaryContainer : Color.clear,
                in: M3Shape.capsule
            )
            .overlay {
                M3Shape.capsule
                    .strokeBorder(isSelected ? .clear : m3.outlineVariant, lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .pressScale()
    }
}

/// Static pill used for grouping/labels (library filter tags, category rows)
/// — same silhouette as FilterChip, no selection state.
struct TagChip: View {
    var title: String
    var systemImage: String? = nil
    var tint: Color?
    var action: (() -> Void)? = nil

    @Environment(\.m3) private var m3

    var body: some View {
        let content = HStack(spacing: 6) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 14, weight: .medium))
            }
            Text(title)
                .font(.m3LabelLarge)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .frame(height: M3Dim.chipHeight)
        .foregroundStyle(tint ?? m3.onSurfaceVariant)
        .background((tint ?? m3.surfaceContainerHighest).opacity(tint == nil ? 1 : 0.16), in: M3Shape.capsule)
        .overlay {
            M3Shape.capsule
                .strokeBorder(tint == nil ? m3.outlineVariant : .clear, lineWidth: 1)
        }

        if let action {
            Button(action: action) { content }
                .buttonStyle(.plain)
                .pressScale()
        } else {
            content
        }
    }
}
