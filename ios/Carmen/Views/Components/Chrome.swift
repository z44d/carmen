//
//  Chrome.swift
//  Carmen — Material app chrome: the floating top app bar, the search
//  field, and the bottom-sheet menu Android uses everywhere instead of
//  context menus.
//

import SwiftUI

// MARK: - Top app bar

/// Transparent-feeling floating header: bold title, optional trailing
/// actions, optional overflow (⋮). Screens place it with
/// `.safeAreaInset(edge: .top)` so scroll content stops beneath it.
struct TopAppBar: View {
    var title: String
    /// Android's LargeFlexibleTopAppBar variant (Settings, detail heroes).
    var large: Bool = false
    var showOverflow: Bool = true
    var onOverflow: () -> Void = {}

    private let trailingContent: AnyView

    @Environment(\.m3) private var m3

    init<Trailing: View>(
        title: String,
        large: Bool = false,
        showOverflow: Bool = true,
        onOverflow: @escaping () -> Void = {},
        @ViewBuilder trailing: () -> Trailing = { EmptyView() }
    ) {
        self.title = title
        self.large = large
        self.showOverflow = showOverflow
        self.onOverflow = onOverflow
        self.trailingContent = AnyView(trailing())
    }

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 0) {
                Text(title)
                    .font(large ? .m3HeadlineMedium : .m3TitleLarge)
                    .foregroundStyle(m3.onSurface)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            Spacer(minLength: 8)
            trailingContent
            if showOverflow {
                Button(action: onOverflow) {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 20, weight: .semibold))
                }
                .buttonStyle(M3IconButtonStyle())
                .accessibilityLabel("More options")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, large ? 16 : 8)
        .frame(minHeight: large ? 104 : M3Dim.appBar, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(m3.background)
    }
}

// MARK: - Search

/// The idle-state fake field (Android's non-editing search bar): tapping
/// anywhere pushes the results screen.
struct M3SearchDock: View {
    var placeholder: String = "Search songs, albums, artists…"
    var action: () -> Void

    @Environment(\.m3) private var m3

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(m3.onSurfaceVariant)
                Text(placeholder)
                    .font(.m3BodyLarge)
                    .foregroundStyle(m3.onSurfaceVariant)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .frame(height: 52)
            .background(m3.surfaceContainerHigh, in: M3Shape.pill)
        }
        .buttonStyle(.plain)
        .pressScale(0.99)
    }
}

/// Editable Material search field (results header): leading magnifier,
/// clear button, 28pt pill.
struct M3SearchField: View {
    @Binding var text: String
    var placeholder: String = "Search"
    var autoFocus: Bool = false
    var onSubmit: () -> Void = {}

    @FocusState private var focused: Bool
    @Environment(\.m3) private var m3

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(m3.onSurfaceVariant)

            TextField(placeholder, text: $text)
                .font(.m3BodyLarge)
                .foregroundStyle(m3.onSurface)
                .tint(m3.primary)
                .submitLabel(.search)
                .focused($focused)
                .onSubmit(onSubmit)

            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 17))
                        .foregroundStyle(m3.onSurfaceVariant)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear")
            }
        }
        .padding(.horizontal, 16)
        .frame(height: 52)
        .background(m3.surfaceContainerHigh, in: M3Shape.pill)
        .onAppear {
            if autoFocus { focused = true }
        }
    }
}

// MARK: - Bottom-sheet menu

extension View {
    /// Presents `content` as Android's BottomSheetMenu: a grabber-topped
    /// medium sheet with the title as header. The content is wrapped in its
    /// own NavigationStack + `carmenDestinations()` so `NavigationLink`s
    /// inside (Go to Album, Go to Artist) push a working screen.
    func bottomSheetMenu<Content: View>(
        isPresented: Binding<Bool>,
        title: String? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        sheet(isPresented: isPresented) {
            SheetMenuView(title: title, content: content)
                .presentationDetents([.medium, .large])
                .presentationGrabber(true)
                .presentationCornerRadius(28)
        }
    }
}

private struct SheetMenuView<Content: View>: View {
    var title: String?
    let content: () -> Content

    @Environment(\.m3) private var m3

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let title {
                        Text(title)
                            .font(.m3TitleMedium)
                            .foregroundStyle(m3.onSurfaceVariant)
                            .lineLimit(2)
                            .padding(.horizontal, 20)
                            .padding(.top, 10)
                            .padding(.bottom, 6)
                    }
                    content()
                        .padding(.bottom, 24)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(m3.background)
            .carmenDestinations()
        }
    }
}

/// Display-only menu row — also the label for `NavigationLink`/`ShareLink`
/// rows inside a sheet.
struct SheetMenuRowLabel: View {
    var title: String
    var systemImage: String
    /// `m3.error` for destructive rows.
    var tint: Color? = nil

    @Environment(\.m3) private var m3

    var body: some View {
        HStack(spacing: 16) {
            Image(systemName: systemImage)
                .font(.system(size: 18, weight: .regular))
                .frame(width: 28)
            Text(title)
                .font(.m3BodyLarge)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            Spacer(minLength: 0)
        }
        .foregroundStyle(tint ?? m3.onSurface)
        .padding(.horizontal, 20)
        .frame(height: 56)
        .contentShape(Rectangle())
    }
}

/// Tappable menu row (56pt, icon + title) used to build sheet menus.
struct SheetMenuRow: View {
    var title: String
    var systemImage: String
    var tint: Color? = nil
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            SheetMenuRowLabel(title: title, systemImage: systemImage, tint: tint)
        }
        .buttonStyle(.plain)
    }
}
