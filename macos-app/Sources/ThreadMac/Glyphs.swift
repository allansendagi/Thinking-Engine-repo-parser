import SwiftUI

/// Line-icons rendered from the design mock's *literal* SVG path data — not re-derived by hand.
/// Each `Kind` below is the exact `d=` string (plus stroke width / caps) copied from the
/// "Premium macOS Panel v2" mock, drawn through a tiny SVG-path interpreter so they match
/// pixel-for-pixel. When the mock changes, paste the new `d=` string; nothing else to tune.
struct Glyph: View {
    enum Kind { case idea, loop, back, refresh, window, plus, clock, cloud, search, ellipsis }
    let kind: Kind
    var size: CGFloat = 14

    var body: some View {
        Canvas { ctx, sz in
            let spec = Self.spec(for: kind)
            let k = sz.width / spec.viewBox
            for shape in spec.shapes {
                let path = shape.scaledPath(k)
                switch shape.paint {
                case let .stroke(w, cap, join):
                    ctx.stroke(path, with: .foreground,
                               style: StrokeStyle(lineWidth: w * k, lineCap: cap, lineJoin: join))
                case .fill:
                    ctx.fill(path, with: .foreground)
                }
            }
        }
        .frame(width: size, height: size)
    }

    // MARK: - Icon table (verbatim from the mock's SVGs)

    private struct Spec { let viewBox: CGFloat; let shapes: [Shape] }

    private static func spec(for kind: Kind) -> Spec {
        switch kind {
        case .back:
            return Spec(viewBox: 16, shapes: [
                .svg("M10.2 2.6L4.8 8l5.4 5.4", .stroke(1.7, .round, .round)),
            ])
        case .refresh:
            return Spec(viewBox: 16, shapes: [
                .svg("M14 8a6 6 0 1 1-1.85-4.33", .stroke(1.5, .round, .round)),
                .svg("M14.2 1.6v3.2h-3.2", .stroke(1.5, .round, .round)),
            ])
        case .window:
            return Spec(viewBox: 16, shapes: [
                .rect(1.5, 3, 13, 10, 2.2, .stroke(1.4, .butt, .round)),
                .svg("M6 3v10", .stroke(1.4, .butt, .round)),
            ])
        case .plus:
            return Spec(viewBox: 16, shapes: [
                .svg("M8 2.2v11.6M2.2 8h11.6", .stroke(1.6, .round, .round)),
            ])
        case .search:
            return Spec(viewBox: 14, shapes: [
                .circle(6.2, 6.2, 4.4, .stroke(1.5, .butt, .round)),
                .svg("M9.6 9.6l2.9 2.9", .stroke(1.5, .round, .round)),
            ])
        case .clock:
            return Spec(viewBox: 16, shapes: [
                .circle(8, 8, 6.3, .stroke(1.35, .butt, .round)),
                .svg("M8 4.4V8l2.4 1.5", .stroke(1.35, .round, .round)),
            ])
        case .ellipsis:
            return Spec(viewBox: 16, shapes: [
                .circle(3.4, 8, 1.1, .fill),
                .circle(8, 8, 1.1, .fill),
                .circle(12.6, 8, 1.1, .fill),
            ])
        case .loop:
            return Spec(viewBox: 16, shapes: [
                .circle(8, 8, 6.3, .stroke(1.4, .butt, .round)),
                .svg("M6.2 6.15a1.85 1.85 0 1 1 1.85 1.9v1.15", .stroke(1.4, .round, .round)),
                .circle(8.05, 11.5, 0.78, .fill),
            ])
        case .idea:
            return Spec(viewBox: 16, shapes: [
                .svg("M8 1.9a4.4 4.4 0 0 0-2.5 8.02v1.33h5V9.92A4.4 4.4 0 0 0 8 1.9Z",
                     .stroke(1.35, .butt, .round)),
                .svg("M6.3 13.3h3.4M6.9 14.7h2.2", .stroke(1.35, .round, .round)),
            ])
        case .cloud:
            return Spec(viewBox: 16, shapes: [
                .svg("M4.6 12.4a3.1 3.1 0 0 1-.35-6.18 4 4 0 0 1 7.72-.7 2.94 2.94 0 0 1-.37 6.88H4.6Z",
                     .stroke(1.35, .round, .round)),
            ])
        }
    }

    // MARK: - Shape

    private enum Paint {
        case stroke(CGFloat, CGLineCap, CGLineJoin)
        case fill
    }

    private enum Shape {
        case svg(String, Paint)
        case circle(CGFloat, CGFloat, CGFloat, Paint)
        case rect(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, Paint)  // x,y,w,h,rx

        var paint: Paint {
            switch self {
            case let .svg(_, p), let .circle(_, _, _, p), let .rect(_, _, _, _, _, p): return p
            }
        }

        func scaledPath(_ k: CGFloat) -> Path {
            var path: Path
            switch self {
            case let .svg(d, _):
                path = SVGPath.parse(d)
            case let .circle(cx, cy, r, _):
                path = Path(ellipseIn: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r))
            case let .rect(x, y, w, h, rx, _):
                path = Path(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerRadius: rx)
            }
            return path.applying(CGAffineTransform(scaleX: k, y: k))
        }
    }
}

/// Minimal SVG path-data interpreter — the subset the mock uses: M/m L/l H/h V/v C/c A/a Z.
/// Elliptical arcs are flattened to short line segments (fine at icon scale). Coordinates are
/// left in the source viewBox space; the caller scales.
enum SVGPath {
    static func parse(_ d: String) -> Path {
        var path = Path()
        var tokens = tokenize(d)
        var i = 0
        var cur = CGPoint.zero
        var start = CGPoint.zero
        var cmd: Character = " "

        func num() -> CGFloat { defer { i += 1 }; return CGFloat(tokens[i].value) }

        while i < tokens.count {
            if let c = tokens[i].command {
                cmd = c
                i += 1
            }
            let rel = cmd.isLowercase
            switch Character(cmd.lowercased()) {
            case "m":
                var pt = CGPoint(x: num(), y: num())
                if rel { pt = CGPoint(x: cur.x + pt.x, y: cur.y + pt.y) }
                cur = pt; start = pt
                path.move(to: pt)
                cmd = rel ? "l" : "L"  // subsequent pairs are implicit line-tos
            case "l":
                var pt = CGPoint(x: num(), y: num())
                if rel { pt = CGPoint(x: cur.x + pt.x, y: cur.y + pt.y) }
                path.addLine(to: pt); cur = pt
            case "h":
                var x = num(); if rel { x += cur.x }
                let pt = CGPoint(x: x, y: cur.y); path.addLine(to: pt); cur = pt
            case "v":
                var y = num(); if rel { y += cur.y }
                let pt = CGPoint(x: cur.x, y: y); path.addLine(to: pt); cur = pt
            case "c":
                var c1 = CGPoint(x: num(), y: num())
                var c2 = CGPoint(x: num(), y: num())
                var end = CGPoint(x: num(), y: num())
                if rel {
                    c1 = CGPoint(x: cur.x + c1.x, y: cur.y + c1.y)
                    c2 = CGPoint(x: cur.x + c2.x, y: cur.y + c2.y)
                    end = CGPoint(x: cur.x + end.x, y: cur.y + end.y)
                }
                path.addCurve(to: end, control1: c1, control2: c2); cur = end
            case "a":
                let rx = num(), ry = num()
                _ = num()  // x-axis-rotation (always 0 in the mock)
                let large = num() != 0
                let sweep = num() != 0
                var end = CGPoint(x: num(), y: num())
                if rel { end = CGPoint(x: cur.x + end.x, y: cur.y + end.y) }
                appendArc(&path, from: cur, to: end, rx: rx, ry: ry, largeArc: large, sweep: sweep)
                cur = end
            case "z":
                path.closeSubpath(); cur = start
            default:
                i += 1
            }
        }
        return path
    }

    // MARK: tokenizer

    private struct Token { var command: Character?; var value: Double = 0 }

    private static func tokenize(_ d: String) -> [Token] {
        var out: [Token] = []
        var numBuf = ""
        func flush() {
            if !numBuf.isEmpty { out.append(Token(command: nil, value: Double(numBuf) ?? 0)); numBuf = "" }
        }
        for ch in d {
            if ch.isLetter {
                flush()
                out.append(Token(command: ch))
            } else if ch == "-" {
                // '-' starts a new number unless it's an exponent sign (no exponents in the mock).
                if !numBuf.isEmpty && numBuf.last != "e" { flush() }
                numBuf.append(ch)
            } else if ch == "." {
                // a second '.' means a new number ("1.85.78" -> 1.85, .78)
                if numBuf.contains(".") { flush() }
                numBuf.append(ch)
            } else if ch == "," || ch == " " || ch == "\n" || ch == "\t" {
                flush()
            } else {
                numBuf.append(ch)
            }
        }
        flush()
        return out
    }

    // MARK: elliptical arc -> polyline (SVG F.6.5 endpoint -> center parametrization, φ = 0)

    private static func appendArc(_ path: inout Path, from p1: CGPoint, to p2: CGPoint,
                                  rx rxIn: CGFloat, ry ryIn: CGFloat, largeArc: Bool, sweep: Bool) {
        var rx = abs(rxIn), ry = abs(ryIn)
        if rx == 0 || ry == 0 { path.addLine(to: p2); return }

        let dx2 = (p1.x - p2.x) / 2, dy2 = (p1.y - p2.y) / 2
        let x1p = dx2, y1p = dy2

        let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
        if lambda > 1 { let s = sqrt(lambda); rx *= s; ry *= s }

        let sign: CGFloat = (largeArc != sweep) ? 1 : -1
        let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
        let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
        let co = sign * sqrt(max(0, num / den))
        let cxp = co * (rx * y1p) / ry
        let cyp = co * -(ry * x1p) / rx

        let cx = cxp + (p1.x + p2.x) / 2
        let cy = cyp + (p1.y + p2.y) / 2

        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let dot = ux * vx + uy * vy
            let len = sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
            var a = acos(min(1, max(-1, dot / len)))
            if ux * vy - uy * vx < 0 { a = -a }
            return a
        }

        let theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
        var dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
        if !sweep && dTheta > 0 { dTheta -= 2 * .pi }
        if sweep && dTheta < 0 { dTheta += 2 * .pi }

        let segs = max(2, Int(ceil(abs(dTheta) / (.pi / 16))))
        for s in 1...segs {
            let t = theta1 + dTheta * CGFloat(s) / CGFloat(segs)
            path.addLine(to: CGPoint(x: cx + rx * cos(t), y: cy + ry * sin(t)))
        }
    }
}
