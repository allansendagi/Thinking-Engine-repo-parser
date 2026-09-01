import SwiftUI

/// The exact line-icons from the design mock, transcribed from its SVG paths so they match
/// pixel-for-pixel (SF Symbols were close but off). All authored on a 16×16 grid.
struct Glyph: View {
    enum Kind { case idea, loop, back, refresh, window, plus, clock, cloud }
    let kind: Kind
    var size: CGFloat = 14
    var weight: CGFloat = 1.4

    var body: some View {
        Canvas { ctx, rectSize in
            let s = rectSize.width / 16
            func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * s, y: y * s) }
            let stroke = GraphicsContext.Shading.foreground
            let lw = weight * s

            switch kind {
            case .idea:
                var bulb = Path()
                bulb.move(to: p(8, 1.9))
                bulb.addCurve(to: p(5.5, 9.92), control1: p(5.57, 1.9), control2: p(3.0, 5.4))
                bulb.addLine(to: p(5.5, 11.25))
                bulb.addLine(to: p(10.5, 11.25))
                bulb.addLine(to: p(10.5, 9.92))
                bulb.addCurve(to: p(8, 1.9), control1: p(13.0, 5.4), control2: p(10.43, 1.9))
                ctx.stroke(bulb, with: stroke, style: .init(lineWidth: lw, lineJoin: .round))
                var base = Path()
                base.move(to: p(6.3, 13.3)); base.addLine(to: p(9.7, 13.3))
                base.move(to: p(6.9, 14.7)); base.addLine(to: p(9.1, 14.7))
                ctx.stroke(base, with: stroke, style: .init(lineWidth: lw, lineCap: .round))

            case .loop:
                ctx.stroke(Path(ellipseIn: CGRect(x: p(1.7, 1.7).x, y: p(1.7, 1.7).y, width: 12.6 * s, height: 12.6 * s)),
                           with: stroke, style: .init(lineWidth: lw))
                var hook = Path()
                hook.move(to: p(6.2, 6.15))
                hook.addCurve(to: p(8.05, 8.05), control1: p(6.2, 5.13), control2: p(7.03, 4.3))
                hook.addCurve(to: p(8.05, 9.2), control1: p(9.1, 8.05), control2: p(8.05, 8.7))
                hook.addLine(to: p(8.05, 9.2))
                ctx.stroke(hook, with: stroke, style: .init(lineWidth: lw, lineCap: .round))
                ctx.fill(Path(ellipseIn: CGRect(x: p(7.27, 10.72).x, y: p(7.27, 10.72).y, width: 1.56 * s, height: 1.56 * s)),
                         with: stroke)

            case .back:
                var pth = Path()
                pth.move(to: p(10.2, 2.6)); pth.addLine(to: p(4.8, 8)); pth.addLine(to: p(10.2, 13.4))
                ctx.stroke(pth, with: stroke, style: .init(lineWidth: 1.7 * s, lineCap: .round, lineJoin: .round))

            case .refresh:
                var arc = Path()
                arc.addArc(center: p(8, 8), radius: 6 * s,
                           startAngle: .degrees(-35), endAngle: .degrees(255), clockwise: false)
                ctx.stroke(arc, with: stroke, style: .init(lineWidth: 1.5 * s, lineCap: .round))
                var head = Path()
                head.move(to: p(14.2, 1.6)); head.addLine(to: p(14.2, 4.8)); head.addLine(to: p(11.0, 4.8))
                ctx.stroke(head, with: stroke, style: .init(lineWidth: 1.5 * s, lineCap: .round, lineJoin: .round))

            case .window:
                ctx.stroke(Path(roundedRect: CGRect(x: 1.5 * s, y: 3 * s, width: 13 * s, height: 10 * s), cornerRadius: 2.2 * s),
                           with: stroke, style: .init(lineWidth: 1.4 * s))
                var div = Path(); div.move(to: p(6, 3)); div.addLine(to: p(6, 13))
                ctx.stroke(div, with: stroke, style: .init(lineWidth: 1.4 * s))

            case .plus:
                var pth = Path()
                pth.move(to: p(8, 2.2)); pth.addLine(to: p(8, 13.8))
                pth.move(to: p(2.2, 8)); pth.addLine(to: p(13.8, 8))
                ctx.stroke(pth, with: stroke, style: .init(lineWidth: 1.6 * s, lineCap: .round))

            case .clock:
                ctx.stroke(Path(ellipseIn: CGRect(x: 1.7 * s, y: 1.7 * s, width: 12.6 * s, height: 12.6 * s)),
                           with: stroke, style: .init(lineWidth: 1.35 * s))
                var hands = Path()
                hands.move(to: p(8, 4.4)); hands.addLine(to: p(8, 8)); hands.addLine(to: p(10.4, 9.5))
                ctx.stroke(hands, with: stroke, style: .init(lineWidth: 1.35 * s, lineCap: .round, lineJoin: .round))

            case .cloud:
                var pth = Path()
                pth.move(to: p(4.6, 12.4))
                pth.addCurve(to: p(4.25, 6.22), control1: p(2.9, 12.4), control2: p(2.55, 7.6))
                pth.addCurve(to: p(11.97, 5.52), control1: p(4.5, 3.5), control2: p(9.5, 3.2))
                pth.addCurve(to: p(11.6, 12.4), control1: p(14.3, 6.0), control2: p(14.1, 11.9))
                pth.addLine(to: p(4.6, 12.4))
                ctx.stroke(pth, with: stroke, style: .init(lineWidth: 1.35 * s, lineJoin: .round))
            }
        }
        .frame(width: size, height: size)
    }
}
