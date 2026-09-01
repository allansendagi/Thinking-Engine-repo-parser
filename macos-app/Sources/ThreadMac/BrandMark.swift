import SwiftUI

/// The Thread glyph — a ring with a rising thread through it and a knot at the centre. Used as
/// the menu-bar icon (as a template) and inside the generated app icon.
struct BrandMark: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height)
        let o = CGPoint(x: rect.midX - s / 2, y: rect.midY - s / 2)
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: o.x + x * s, y: o.y + y * s) }

        var path = Path()
        // ring
        path.addEllipse(in: CGRect(x: o.x + 0.08 * s, y: o.y + 0.08 * s, width: 0.84 * s, height: 0.84 * s))
        // thread passing through, bottom-left to top-right
        path.move(to: p(0.22, 0.74))
        path.addCurve(to: p(0.78, 0.26), control1: p(0.40, 0.60), control2: p(0.60, 0.40))
        return path
    }
}

/// Filled version for the menu bar: stroked ring + thread + a solid knot.
struct MenuBarGlyph: View {
    var body: some View {
        ZStack {
            Circle().stroke(lineWidth: 1.6).frame(width: 13, height: 13)
            Path { p in
                p.move(to: CGPoint(x: 2, y: 12))
                p.addCurve(to: CGPoint(x: 14, y: 3), control1: CGPoint(x: 6, y: 9), control2: CGPoint(x: 10, y: 6))
            }
            .stroke(lineWidth: 1.6)
            .frame(width: 16, height: 15)
            Circle().frame(width: 3, height: 3)
        }
        .frame(width: 18, height: 18)
    }
}
