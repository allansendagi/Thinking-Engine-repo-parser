import AppKit
import SwiftUI

/// The Thread glyph — a ring with a thread rising through it and a knot at the centre.
enum BrandMark {
    /// A template NSImage for the menu-bar item. Rendered once. `isTemplate` lets macOS tint it
    /// for light/dark menu bars automatically — the reliable way to put a custom shape up there
    /// (a raw SwiftUI Shape as a MenuBarExtra label can render invisibly).
    static let menuBarImage: NSImage = {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: false) { rect in
            let c = CGPoint(x: rect.midX, y: rect.midY)
            let r = rect.width * 0.34
            NSColor.black.setStroke()

            let ring = NSBezierPath(ovalIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
            ring.lineWidth = 1.6
            ring.stroke()

            let thread = NSBezierPath()
            thread.move(to: CGPoint(x: c.x - r * 1.6, y: c.y - r * 1.5))
            thread.curve(
                to: CGPoint(x: c.x + r * 1.6, y: c.y + r * 1.5),
                controlPoint1: CGPoint(x: c.x - r * 0.2, y: c.y - r * 0.7),
                controlPoint2: CGPoint(x: c.x + r * 0.2, y: c.y + r * 0.7)
            )
            thread.lineWidth = 1.6
            thread.lineCapStyle = .round
            thread.stroke()

            let k = r * 0.42
            NSColor.black.setFill()
            NSBezierPath(ovalIn: CGRect(x: c.x - k, y: c.y - k, width: 2 * k, height: 2 * k)).fill()
            return true
        }
        image.isTemplate = true
        return image
    }()
}
