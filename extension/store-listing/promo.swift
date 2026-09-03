#!/usr/bin/env swift
// Chrome Web Store promo tiles. Minimal: the indigo field, the white Thread mark, the wordmark.
// No screenshots, no slogans. Run on macOS:  swift store-listing/promo.swift
import AppKit

func tile(w: CGFloat, h: CGFloat) -> Data {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: Int(w), pixelsHigh: Int(h),
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    rep.size = NSSize(width: w, height: h)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    defer { NSGraphicsContext.restoreGraphicsState() }

    let rect = CGRect(x: 0, y: 0, width: w, height: h)
    NSGradient(colors: [
        NSColor(calibratedRed: 0.40, green: 0.44, blue: 0.86, alpha: 1),
        NSColor(calibratedRed: 0.26, green: 0.28, blue: 0.58, alpha: 1),
    ])!.draw(in: rect, angle: -60)

    // Mark, sitting a little left of centre; wordmark to its right. Whole lockup centred.
    let markD = h * 0.42
    let gap = markD * 0.44
    let font = NSFont.systemFont(ofSize: h * 0.2, weight: .semibold)
    let word = "Thread" as NSString
    let attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: NSColor.white,
        .kern: -h * 0.006,
    ]
    let wordW = word.size(withAttributes: attrs).width
    let lockupW = markD + gap + wordW
    let originX = (w - lockupW) / 2
    let cy = h / 2

    let c = CGPoint(x: originX + markD / 2, y: cy)
    let r = markD * 0.34
    let stroke = markD * 0.07
    NSColor.white.setStroke()
    let ring = NSBezierPath(ovalIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
    ring.lineWidth = stroke
    ring.stroke()
    let thread = NSBezierPath()
    thread.move(to: CGPoint(x: c.x - r * 1.5, y: c.y - r * 1.4))
    thread.curve(
        to: CGPoint(x: c.x + r * 1.5, y: c.y + r * 1.4),
        controlPoint1: CGPoint(x: c.x - r * 0.2, y: c.y - r * 0.65),
        controlPoint2: CGPoint(x: c.x + r * 0.2, y: c.y + r * 0.65)
    )
    thread.lineWidth = stroke
    thread.lineCapStyle = .round
    thread.stroke()
    let k = r * 0.4
    NSColor.white.setFill()
    NSBezierPath(ovalIn: CGRect(x: c.x - k, y: c.y - k, width: 2 * k, height: 2 * k)).fill()

    let textY = cy - word.size(withAttributes: attrs).height / 2
    word.draw(at: CGPoint(x: originX + markD + gap, y: textY), withAttributes: attrs)

    return rep.representation(using: .png, properties: [:])!
}

let dir = URL(fileURLWithPath: (#file as NSString).deletingLastPathComponent)
for (name, w, h) in [("promo-440x280", 440.0, 280.0), ("promo-1400x560", 1400.0, 560.0)] {
    let out = dir.appendingPathComponent("\(name).png")
    try! tile(w: w, h: h).write(to: out)
    print("wrote \(out.lastPathComponent)")
}
