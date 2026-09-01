#!/usr/bin/env swift
// Draws the Thread app icon (1024px master) and emits AppIcon.icns.
// Run: swift icon.swift   (macOS, no deps)
import AppKit

let px: CGFloat = 1024
let img = NSImage(size: NSSize(width: px, height: px))
img.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext

// macOS squircle
let inset: CGFloat = px * 0.09
let rect = CGRect(x: inset, y: inset, width: px - 2 * inset, height: px - 2 * inset)
let squircle = NSBezierPath(roundedRect: rect, xRadius: rect.width * 0.225, yRadius: rect.height * 0.225)
squircle.addClip()

// indigo gradient
let g = NSGradient(colors: [
    NSColor(calibratedRed: 0.40, green: 0.44, blue: 0.86, alpha: 1),
    NSColor(calibratedRed: 0.28, green: 0.30, blue: 0.62, alpha: 1),
])!
g.draw(in: rect, angle: -90)

// subtle top sheen
NSColor.white.withAlphaComponent(0.10).setFill()
NSBezierPath(rect: CGRect(x: rect.minX, y: rect.midY, width: rect.width, height: rect.height / 2)).fill()

// Thread mark: ring + thread + knot, centred
let c = CGPoint(x: px / 2, y: px / 2)
let r = px * 0.235
NSColor.white.setStroke()

let ring = NSBezierPath(ovalIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
ring.lineWidth = px * 0.055
ring.stroke()

let thread = NSBezierPath()
thread.move(to: CGPoint(x: c.x - r * 1.25, y: c.y - r * 1.15))
thread.curve(
    to: CGPoint(x: c.x + r * 1.25, y: c.y + r * 1.15),
    controlPoint1: CGPoint(x: c.x - r * 0.2, y: c.y - r * 0.55),
    controlPoint2: CGPoint(x: c.x + r * 0.2, y: c.y + r * 0.55)
)
thread.lineWidth = px * 0.055
thread.lineCapStyle = .round
thread.stroke()

let knotR = px * 0.055
NSColor.white.setFill()
NSBezierPath(ovalIn: CGRect(x: c.x - knotR, y: c.y - knotR, width: 2 * knotR, height: 2 * knotR)).fill()

img.unlockFocus()

guard let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
    fputs("failed to render\n", stderr); exit(1)
}
let out = "dist/AppIcon-1024.png"
try? FileManager.default.createDirectory(atPath: "dist", withIntermediateDirectories: true)
try! png.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
