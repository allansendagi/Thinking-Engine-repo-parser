import AppKit
import SwiftUI

/// A borderless key-capable panel — the standard Spotlight/Raycast-style host. `.titled` +
/// transparent + fullSizeContentView is the flaky combo that made the panel flash and vanish;
/// a plain borderless NSPanel with an explicit `canBecomeKey` is stable.
private final class FloatingPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class QuickRecallPanel {
    private let panel: FloatingPanel
    /// The menu-bar status button, if opened from the menu bar — anchors the panel under it.
    weak var anchorButton: NSStatusBarButton?

    init(appState: AppState) {
        let hosting = NSHostingController(rootView: RootView().environmentObject(appState))
        hosting.view.wantsLayer = true

        let panel = FloatingPanel(
            contentRect: NSRect(x: 0, y: 0, width: Theme.panelWidth, height: Theme.panelHeight),
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.contentViewController = hosting
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.isMovableByWindowBackground = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        // Transparent window; the SwiftUI root paints its #F6F6F8 material and clips to a 12pt
        // rounded rect. The window only supplies the drop shadow.
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        self.panel = panel
    }

    func toggle() {
        if panel.isVisible {
            panel.orderOut(nil)
        } else {
            position()
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
        }
    }

    /// Anchor under the menu-bar item when we have it; otherwise top-centre of the active screen.
    /// Never re-centres once shown, so it can't "jump".
    private func position() {
        let size = panel.frame.size
        if let win = anchorButton?.window {
            let b = win.convertToScreen(anchorButton!.convert(anchorButton!.bounds, to: nil))
            let screen = win.screen ?? NSScreen.main
            let visible = screen?.visibleFrame ?? .zero
            var x = b.midX - size.width / 2
            x = min(max(x, visible.minX + 8), visible.maxX - size.width - 8)
            let y = b.minY - size.height - 6
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        } else if let screen = NSScreen.main {
            let f = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: f.midX - size.width / 2, y: f.maxY - size.height - 12))
        }
    }
}
