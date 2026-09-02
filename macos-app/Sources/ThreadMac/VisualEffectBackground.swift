import AppKit
import SwiftUI

/// The panel's translucent material — real macOS vibrancy (blur + saturation behind the window),
/// which adapts to light/dark automatically. This is what the redesign's
/// `backdrop-filter: blur(64px) saturate(180%)` is approximating.
struct VisualEffectBackground: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .popover
    var blending: NSVisualEffectView.BlendingMode = .behindWindow

    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = material
        v.blendingMode = blending
        v.state = .active
        // The design panel is a *light* frosted surface regardless of system appearance.
        v.appearance = NSAppearance(named: .aqua)
        return v
    }

    func updateNSView(_ v: NSVisualEffectView, context: Context) {
        v.material = material
        v.blendingMode = blending
        v.appearance = NSAppearance(named: .aqua)
    }
}
