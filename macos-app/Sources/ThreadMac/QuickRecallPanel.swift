import AppKit
import SwiftUI

/// A floating, key-able NSPanel shown/hidden by the global hotkey -- the "press a shortcut,
/// recall your thinking" interaction from the original design. Reuses RootView rather than a
/// separate UI, both hosted with the same AppState so pairing/search/selection stay consistent
/// whether opened from the menu bar or the hotkey.
final class QuickRecallPanel {
    private let panel: NSPanel
    private let appState: AppState

    init(appState: AppState) {
        self.appState = appState

        let hosting = NSHostingController(rootView: RootView().environmentObject(appState))
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: Theme.panelWidth, height: Theme.panelHeight),
            styleMask: [.titled, .closable, .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.contentViewController = hosting
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        // Transparent window -- the SwiftUI root paints its own translucent material and clips to
        // a 12pt rounded rect. The panel just provides the drop shadow.
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.contentView?.wantsLayer = true
        panel.contentView?.layer?.masksToBounds = false
        self.panel = panel
    }

    func toggle() {
        if panel.isVisible {
            panel.orderOut(nil)
        } else {
            centerOnActiveScreen()
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
        }
    }

    private func centerOnActiveScreen() {
        guard let screen = NSScreen.main else { return }
        let screenFrame = screen.visibleFrame
        let size = panel.frame.size
        let origin = NSPoint(
            x: screenFrame.midX - size.width / 2,
            y: screenFrame.midY - size.height / 2 + screenFrame.height * 0.15
        )
        panel.setFrameOrigin(origin)
    }
}
