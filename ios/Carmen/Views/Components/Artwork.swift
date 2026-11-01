//
//  Artwork.swift
//  Carmen — square artwork + the explicit marker.
//
//  Moved verbatim from the old shared Components.swift: the JPEG-first
//  fallback chain, the network-generation re-key and the neutral placeholder
//  are behavior, not style — they stay exactly as they were.
//

import SwiftUI

/// Square artwork with a JPEG-first fallback chain and a neutral placeholder —
/// never a broken image.
struct ArtworkView: View {
    let url: String?
    var fallbackURL: String?
    var cornerRadius: CGFloat = 6
    var placeholderSymbol: String = "music.note"

    var body: some View {
        Group {
            if let urlString = url, let url = URL(string: urlString) {
                AsyncImage(url: url, transaction: Transaction(animation: .easeInOut(duration: 0.15))) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    case .failure:
                        fallbackOrPlaceholder
                    case .empty:
                        placeholder
                    @unknown default:
                        placeholder
                    }
                }
            } else {
                fallbackOrPlaceholder
            }
        }
        // A failed (offline) load is remembered by the AsyncImage forever —
        // re-key it whenever connectivity flips so covers reload themselves.
        .id(NetworkMonitor.shared.generation)
        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
        .clipped()
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .strokeBorder(.primary.opacity(0.06), lineWidth: 0.5)
        )
    }

    @ViewBuilder private var fallbackOrPlaceholder: some View {
        if let fallbackURL, fallbackURL != url, let url = URL(string: fallbackURL) {
            AsyncImage(url: url) { phase in
                if case .success(let image) = phase {
                    image.resizable().scaledToFill()
                } else {
                    placeholder
                }
            }
        } else {
            placeholder
        }
    }

    private var placeholder: some View {
        ZStack {
            Rectangle().fill(Color(.secondarySystemFill))
            Image(systemName: placeholderSymbol)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.secondary)
        }
    }
}

/// The "E" marker next to explicit titles.
struct ExplicitBadge: View {
    var body: some View {
        Text("E")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(.secondary)
            .frame(width: 13, height: 13)
            .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 3, style: .continuous))
    }
}
