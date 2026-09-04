import SwiftUI

/// Exact palette from the "Premium macOS Panel v2" design (Claude Design cf5ae711).
/// The panel is forced light for now — every value below is the literal from the mock.
enum Theme {
    /// #0A6FFF — the design's default accent (options: #8944AB, #3A8D3F, #C0453B). User-adjustable
    /// via Settings ▸ Appearance; AppState pushes the choice into `accentOverride` so every view
    /// that reads `Theme.accent` in its body picks it up on the next render.
    static var accentOverride: Color?
    static var accent: Color { accentOverride ?? AccentChoice.blue.color }

    // rgba(0,0,0,a) — panel is light, so ink is pure black at an alpha.
    static func ink(_ a: Double) -> Color { Color.black.opacity(a) }
    // rgba(255,255,255,a) — for text/icons on a selected (accent-filled) row.
    static func onAccent(_ a: Double) -> Color { Color.white.opacity(a) }

    // Panel surface: rgba(246,246,248,.82) over the blurred material.
    static let panelTint = Color(red: 246 / 255, green: 246 / 255, blue: 248 / 255)
    /// Sticky section-header band ("Today" / "Yesterday"). The mock is rgba(246,246,248,.9) over a
    /// heavy blur; rendered near-opaque here so the band reads as a crisp light strip, not a grey
    /// smudge (which is what .ultraThinMaterial gave in light mode).
    static let stickyTint = Color(red: 247 / 255, green: 247 / 255, blue: 249 / 255).opacity(0.96)

    static let hairline = Color.black.opacity(0.09)          // rgba(0,0,0,.09)
    static let fieldFill = Color.black.opacity(0.055)         // rgba(0,0,0,.055)
    static let hoverFill = Color.black.opacity(0.05)          // rgba(0,0,0,.05)
    /// "Thread Idea Detail.dc.html": section-header row hover (quieter) vs. an actionable list
    /// item's hover (more visible) — the mock deliberately uses two different values, not one.
    static let rowHoverFill = Color.black.opacity(0.02)       // rgba(0,0,0,.02)
    static let itemHoverFill = Color.black.opacity(0.04)      // rgba(0,0,0,.04)
    static let cardFill = Color.white.opacity(0.66)           // rgba(255,255,255,.66)
    static let cardStroke = Color.black.opacity(0.09)
    static let cardCorner: CGFloat = 9
    static let rail = Color.black.opacity(0.12)               // rgba(0,0,0,.12)
    static let railDot = Color.black.opacity(0.28)            // rgba(0,0,0,.28)
    static let rowSep = Color.black.opacity(0.07)             // rgba(0,0,0,.07)

    // Panel geometry (420 × 748, 12pt radius).
    static let panelWidth: CGFloat = 420
    static let panelHeight: CGFloat = 748
    static let corner: CGFloat = 12

    static func stateColor(_ state: String) -> Color {
        switch state.lowercased() {
        case "developing": return accent
        case "established": return Color(red: 58 / 255, green: 141 / 255, blue: 63 / 255) // #3A8D3F
        case "rejected": return Color(red: 192 / 255, green: 69 / 255, blue: 59 / 255)    // #C0453B
        case "contested": return Color(red: 199 / 255, green: 138 / 255, blue: 42 / 255)  // #C78A2A -- unresolved tension
        default: return ink(0.4)
        }
    }

    /// "just now" / "24m ago" / "1h ago" / "3d ago" / "Aug 17".
    static func ago(_ iso: String) -> String {
        guard let d = parse(iso) else { return "" }
        return ago(d)
    }

    static func ago(_ d: Date) -> String {
        let s = Date().timeIntervalSince(d)
        switch s {
        case ..<90: return "just now"
        case ..<3600: return "\(Int(s / 60))m ago"
        case ..<86_400: return "\(Int(s / 3600))h ago"
        case ..<604_800: return "\(Int(s / 86_400))d ago"
        default:
            let f = DateFormatter(); f.dateFormat = "MMM d"; return f.string(from: d)
        }
    }

    static func relative(_ iso: String) -> String {
        guard let d = parse(iso) else { return "" }
        let s = Date().timeIntervalSince(d)
        switch s {
        case ..<3600: return "\(max(1, Int(s / 60)))m"
        case ..<86_400: return "\(Int(s / 3600))h"
        case ..<604_800: return "\(Int(s / 86_400))d"
        default:
            let f = DateFormatter(); f.dateFormat = "MMM d"; return f.string(from: d)
        }
    }

    static func bucket(_ iso: String) -> (order: Int, label: String) {
        guard let d = parse(iso) else { return (4, "Earlier") }
        let c = Calendar.current
        if c.isDateInToday(d) { return (0, "Today") }
        if c.isDateInYesterday(d) { return (1, "Yesterday") }
        if let days = c.dateComponents([.day], from: d, to: Date()).day, days < 7 { return (2, "This week") }
        return (3, "Earlier")
    }

    static func parse(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }
}

/// Small uppercase state chip.
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

// MARK: - User appearance preferences (Settings ▸ Appearance)

/// Accent colour options from the design mock. `.blue` is the default #0A6FFF.
enum AccentChoice: String, CaseIterable, Identifiable {
    case blue, purple, green, red
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
    var color: Color {
        switch self {
        case .blue:   return Color(red: 10 / 255,  green: 111 / 255, blue: 255 / 255) // #0A6FFF
        case .purple: return Color(red: 137 / 255, green: 68 / 255,  blue: 171 / 255) // #8944AB
        case .green:  return Color(red: 58 / 255,  green: 141 / 255, blue: 63 / 255)  // #3A8D3F
        case .red:    return Color(red: 192 / 255, green: 69 / 255,  blue: 59 / 255)  // #C0453B
        }
    }
}

/// Row density. Drives IdeaRowView's paddings and type sizes.
enum Density: String, CaseIterable, Identifiable {
    case compact, regular, comfortable
    var id: String { rawValue }
    var label: String { rawValue.capitalized }

    var rowPadding: EdgeInsets {
        switch self {
        case .compact:     return .init(top: 8, leading: 10, bottom: 9, trailing: 10)
        case .regular:     return .init(top: 10, leading: 12, bottom: 11, trailing: 12)
        case .comfortable: return .init(top: 13, leading: 14, bottom: 14, trailing: 14)
        }
    }
    var hSpacing: CGFloat { self == .compact ? 9 : 11 }
    var titleSize: CGFloat { switch self { case .compact: 12.5; case .regular: 13; case .comfortable: 13.5 } }
    var bodySize: CGFloat { switch self { case .compact: 11.5; case .regular: 12; case .comfortable: 12.5 } }
    var glyphSize: CGFloat { self == .compact ? 14 : 15 }
}

/// The mock's secondary buttons: white fill, hairline + soft shadow.
extension View {
    func raisedControl() -> some View {
        self
            .background(Color.white)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.ink(0.13), lineWidth: 0.5))
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .shadow(color: .black.opacity(0.1), radius: 1, y: 1)
    }
}
