import SwiftUI

import AppKit

extension Color {
    /// A colour that resolves for the Mac's current appearance. The light value is always the
    /// design's literal, so light mode looks exactly as designed; the dark value is its counterpart.
    static func adaptive(light: NSColor, dark: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
        })
    }
}

private func rgb(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) -> NSColor {
    NSColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
}
/// Black at `a` in light mode, white at `a` in dark: how every "ink on a surface" value flips.
private func flipInk(light a: Double, dark b: Double) -> Color {
    .adaptive(light: NSColor.black.withAlphaComponent(a), dark: NSColor.white.withAlphaComponent(b))
}

/// Palette from the "Premium macOS Panel v2" design (Claude Design cf5ae711). Every value is the
/// design's literal in light mode; dark mode follows the system appearance with its counterpart.
enum Theme {
    /// The system accent colour, as chosen in System Settings -- not an app-specific colour.
    static var accent: Color { .accentColor }

    // rgba(0,0,0,a) on light, rgba(255,255,255,a) on dark: text and icons on the panel.
    static func ink(_ a: Double) -> Color { flipInk(light: a, dark: a) }
    // rgba(255,255,255,a) — for text/icons on a selected (accent-filled) row.
    static func onAccent(_ a: Double) -> Color { Color.white.opacity(a) }

    // Panel surface: rgba(246,246,248,.82) over the blurred material.
    static let panelTint = Color.adaptive(light: rgb(246, 246, 248), dark: rgb(30, 30, 32))
    /// Sticky section-header band ("Today" / "Yesterday"). The mock is rgba(246,246,248,.9) over a
    /// heavy blur; rendered near-opaque here so the band reads as a crisp strip, not a grey smudge.
    static let stickyTint = Color.adaptive(light: rgb(247, 247, 249, 0.96), dark: rgb(38, 38, 41, 0.96))

    static let hairline = flipInk(light: 0.09, dark: 0.12)
    static let fieldFill = flipInk(light: 0.055, dark: 0.09)
    static let hoverFill = flipInk(light: 0.05, dark: 0.08)
    /// "Thread Idea Detail.dc.html": section-header row hover (quieter) vs. an actionable list
    /// item's hover (more visible) — the mock deliberately uses two different values, not one.
    static let rowHoverFill = flipInk(light: 0.02, dark: 0.04)
    static let itemHoverFill = flipInk(light: 0.04, dark: 0.07)
    static let cardFill = Color.adaptive(light: NSColor.white.withAlphaComponent(0.66), dark: NSColor.white.withAlphaComponent(0.07))
    /// The slightly lighter card the idea page uses (rgba(255,255,255,.62)).
    static let cardFillSoft = Color.adaptive(light: NSColor.white.withAlphaComponent(0.62), dark: NSColor.white.withAlphaComponent(0.07))
    static let cardStroke = flipInk(light: 0.09, dark: 0.13)
    static let cardCorner: CGFloat = 9
    static let rail = flipInk(light: 0.12, dark: 0.2)
    static let railDot = flipInk(light: 0.28, dark: 0.4)
    static let rowSep = flipInk(light: 0.07, dark: 0.1)

    /// A raised control surface: the selected tab's pill, a field that sits above the panel.
    static let raised = Color.adaptive(light: .white, dark: NSColor.white.withAlphaComponent(0.17))
    /// The 0.5pt inner highlight and outer hairline around the panel.
    static let edgeHighlight = Color.adaptive(light: NSColor.white.withAlphaComponent(0.7), dark: NSColor.white.withAlphaComponent(0.1))
    static let edgeHairline = Color.adaptive(light: NSColor.black.withAlphaComponent(0.22), dark: NSColor.black.withAlphaComponent(0.6))
    /// The ring around a timeline dot, matching the card it sits on.
    static let dotHalo = Color.adaptive(light: NSColor.white.withAlphaComponent(0.75), dark: rgb(34, 34, 37, 0.9))

    // Panel geometry (420 × 748, 12pt radius).
    static let panelWidth: CGFloat = 420
    static let panelHeight: CGFloat = 748
    static let corner: CGFloat = 12

    static func stateColor(_ state: String) -> Color {
        switch state.lowercased() {
        case "developing": return accent
        case "established": return .adaptive(light: rgb(58, 141, 63), dark: rgb(96, 190, 102))    // #3A8D3F
        case "rejected": return .adaptive(light: rgb(192, 69, 59), dark: rgb(240, 110, 99))       // #C0453B
        case "contested": return .adaptive(light: rgb(199, 138, 42), dark: rgb(238, 176, 78))     // #C78A2A -- unresolved tension
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
