import SwiftUI

/// Visual language for the panel, following the "Premium macOS" redesign: SF system font, the
/// system accent colour (blue by default), a translucent material surface, hairline separators,
/// and full-accent selection like a macOS source list. Semantic colours throughout so it renders
/// correctly in light *and* dark (the design mock is the light rendering).
enum Theme {
    /// Respects the user's system accent (blue out of the box — the design's #0A6FFF).
    static let accent = Color(nsColor: .controlAccentColor)

    /// One tint per idea state, restrained macOS palette.
    static func stateColor(_ state: String) -> Color {
        switch state.lowercased() {
        case "developing": return accent
        case "established": return Color(nsColor: .systemGreen)
        case "rejected": return Color(nsColor: .systemRed).opacity(0.85)
        case "dormant": return .secondary
        default: return .secondary
        }
    }

    // Panel geometry (from the redesign: 420 × 748, 12pt radius).
    static let panelWidth: CGFloat = 420
    static let panelHeight: CGFloat = 748
    static let corner: CGFloat = 12
    static let cardCorner: CGFloat = 9

    /// Adaptive stand-ins for the mock's rgba(0,0,0,x) / rgba(255,255,255,x) values.
    static func ink(_ a: Double) -> Color { Color.primary.opacity(a) }
    static let hairline = Color.primary.opacity(0.09)
    static let fieldFill = Color.primary.opacity(0.055)
    static let cardFill = Color.primary.opacity(0.04)
    static let cardStroke = Color.primary.opacity(0.09)
    static let hoverFill = Color.primary.opacity(0.05)

    /// Short relative time: "24m ago", "1h ago", "3d ago", "Aug 17".
    static func ago(_ iso: String) -> String {
        guard let date = parse(iso) else { return "" }
        let s = Date().timeIntervalSince(date)
        switch s {
        case ..<90: return "just now"
        case ..<3600: return "\(Int(s / 60))m ago"
        case ..<86_400: return "\(Int(s / 3600))h ago"
        case ..<604_800: return "\(Int(s / 86_400))d ago"
        default:
            let d = DateFormatter(); d.dateFormat = "MMM d"
            return d.string(from: date)
        }
    }

    /// Compact form for tight metadata: "24m", "1h", "3d", "Aug 17".
    static func relative(_ iso: String) -> String {
        guard let date = parse(iso) else { return "" }
        let s = Date().timeIntervalSince(date)
        switch s {
        case ..<3600: return "\(max(1, Int(s / 60)))m"
        case ..<86_400: return "\(Int(s / 3600))h"
        case ..<604_800: return "\(Int(s / 86_400))d"
        default:
            let d = DateFormatter(); d.dateFormat = "MMM d"
            return d.string(from: date)
        }
    }

    /// "Today" / "Yesterday" / "This week" / "Earlier" bucket for a timestamp.
    static func bucket(_ iso: String) -> (order: Int, label: String) {
        guard let date = parse(iso) else { return (4, "Earlier") }
        let cal = Calendar.current
        if cal.isDateInToday(date) { return (0, "Today") }
        if cal.isDateInYesterday(date) { return (1, "Yesterday") }
        if let days = cal.dateComponents([.day], from: date, to: Date()).day, days < 7 { return (2, "This week") }
        return (3, "Earlier")
    }

    static func parse(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }
}

/// Small uppercase state chip, tinted per state.
struct StatePill: View {
    let state: String
    var body: some View {
        Text(state)
            .font(.system(size: 9, weight: .medium)).textCase(.uppercase).kerning(0.4)
            .foregroundStyle(Theme.stateColor(state))
            .padding(.horizontal, 5).padding(.vertical, 2)
            .background(Theme.stateColor(state).opacity(0.14), in: Capsule())
    }
}

extension View {
    /// A raised white control (the mock's secondary buttons): opaque fill, hairline + soft shadow.
    func raisedControl() -> some View {
        self
            .background(Color(nsColor: .textBackgroundColor))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.ink(0.13), lineWidth: 0.5))
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .shadow(color: .black.opacity(0.12), radius: 1.5, y: 1)
    }
}
