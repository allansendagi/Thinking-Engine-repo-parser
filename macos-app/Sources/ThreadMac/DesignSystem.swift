import SwiftUI

/// One place for the calm, slightly-serious visual language the panel is meant to have (see the
/// UI spec): system font throughout, a muted accent, soft cards, generous whitespace, and colors
/// that resolve correctly in both light and dark mode.
enum Theme {
    /// Muted indigo -- calm, not playful, distinct from system blue.
    static let accent = Color(red: 0.36, green: 0.40, blue: 0.78)

    static let panelWidth: CGFloat = 380
    static let panelHeight: CGFloat = 520
    static let corner: CGFloat = 10
    static let cardCorner: CGFloat = 8

    /// Card fill that has real contrast in both appearances (NSColor.textBackgroundColor is too
    /// close to the panel bg in dark mode).
    static let cardFill = Color(nsColor: .quaternaryLabelColor).opacity(0.35)
    static let cardStroke = Color(nsColor: .separatorColor)
    static let panelBackground = Color(nsColor: .windowBackgroundColor)
}

extension View {
    /// Standard idea/loop card: soft fill, hairline border, rounded, full-width, tappable.
    func threadCard() -> some View {
        self
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.cardFill)
            .overlay(RoundedRectangle(cornerRadius: Theme.cardCorner).stroke(Theme.cardStroke, lineWidth: 0.5))
            .clipShape(RoundedRectangle(cornerRadius: Theme.cardCorner))
            .contentShape(Rectangle())
    }

    func sectionHeader() -> some View {
        self
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
            .kerning(0.6)
    }
}
