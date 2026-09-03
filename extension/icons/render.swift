#!/usr/bin/env swift
// Emits the Thread browser-extension icons (16/32/48/128 px) into this directory.
// Run on macOS: swift icons/render.swift   (no deps -- AppKit only)
//
// Same brand family as macos-app/icon.swift: an indigo squircle with the white
// ring + thread + knot mark. Tuned for small sizes -- heavier relative strokes so
// the glyph still reads at 16px in the Chrome toolbar.
//
// Draws straight into an NSBitmapImageRep of the exact pixel size (not via
// NSImage.lockFocus, which renders at the display's 2x backing scale).
import AppKit

func drawIcon(px: CGFloat) -> Data {
    let n = Int(px)
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: n, pixelsHigh: n,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    )!
    rep.size = NSSize(width: px, height: px)

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    defer { NSGraphicsContext.restoreGraphicsState() }

    // Rounded-square plate. Tighter corner than the macOS squircle so it doesn't
    // look like a blob at 16px.
    let pad = px * 0.045
    let rect = CGRect(x: pad, y: pad, width: px - 2 * pad, height: px - 2 * pad)
    let radius = rect.width * (px <= 32 ? 0.24 : 0.28)
    NSGraphicsContext.current!.cgContext.saveGState()
    let plate = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
    plate.addClip()

    let g = NSGradient(colors: [
        NSColor(calibratedRed: 0.40, green: 0.44, blue: 0.86, alpha: 1),
        NSColor(calibratedRed: 0.28, green: 0.30, blue: 0.62, alpha: 1),
    ])!
    g.draw(in: rect, angle: -90)
    NSGraphicsContext.current!.cgContext.restoreGState()

    // Mark.
    let c = CGPoint(x: px / 2, y: px / 2)
    let r = px * 0.24
    let stroke = max(px * 0.085, 1.4)
    NSColor.white.setStroke()

    let ring = NSBezierPath(ovalIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
    ring.lineWidth = stroke
    ring.stroke()

    // Shorter thread tails at tiny sizes so they don't clip on the plate edge or crowd the ring.
    let reach: CGFloat = px <= 32 ? 1.12 : 1.35
    let thread = NSBezierPath()
    thread.move(to: CGPoint(x: c.x - r * reach, y: c.y - r * (reach - 0.07)))
    thread.curve(
        to: CGPoint(x: c.x + r * reach, y: c.y + r * (reach - 0.07)),
        controlPoint1: CGPoint(x: c.x - r * 0.2, y: c.y - r * 0.6),
        controlPoint2: CGPoint(x: c.x + r * 0.2, y: c.y + r * 0.6)
    )
    thread.lineWidth = stroke
    thread.lineCapStyle = .round
    thread.stroke()

    let knotR = max(px * (px <= 32 ? 0.1 : 0.075), 1.6)
    NSColor.white.setFill()
    NSBezierPath(ovalIn: CGRect(x: c.x - knotR, y: c.y - knotR, width: 2 * knotR, height: 2 * knotR)).fill()

    guard let png = rep.representation(using: .png, properties: [:]) else {
        fputs("render failed at \(px)px\n", stderr); exit(1)
    }
    return png
}

let dir = URL(fileURLWithPath: (#file as NSString).deletingLastPathComponent)
for size in [16, 32, 48, 128] {
    let data = drawIcon(px: CGFloat(size))
    let out = dir.appendingPathComponent("icon\(size).png")
    try! data.write(to: out)
    print("wrote \(out.lastPathComponent) (\(data.count) bytes)")
}
