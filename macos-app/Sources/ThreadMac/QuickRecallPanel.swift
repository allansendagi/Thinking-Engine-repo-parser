import AppKit
import SwiftUI

extension Notification.Name {
    /// Posted from SwiftUI (Escape, "Open in Window") to ask the floating panel to dismiss —
    /// SwiftUI has no direct handle on the NSPanel.
    static let threadDismissPanel = Notification.Name("thread.dismissPanel")
}

/// A borderless key-capable panel — the standard Spotlight/Raycast-style host. `.titled` +
/// transparent + fullSizeContentView is the flaky combo that made the panel flash and vanish;
/// a plain borderless NSPanel with an explicit `canBecomeKey` is stable.
private final class FloatingPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// Owns the menu-bar / ⌘⇧T quick-recall panel and, crucially, its *dismissal* rules — the part
/// that makes it feel like a native menu-bar utility rather than a stray window:
///   • click anywhere outside it            → closes  (resignKey)
///   • open the full window, or press Esc   → closes  (.threadDismissPanel)
///   • click the menu-bar icon / ⌘⇧T again  → toggles
/// A short guard stops the "click the menu-bar icon while the panel is open" case from closing
/// (via resignKey) and immediately reopening (via the button action) in the same run loop pass.
final class QuickRecallPanel: NSObject, NSWindowDelegate {
    private let panel: FloatingPanel
    /// The menu-bar status button, if opened from the menu bar — anchors the panel under it.
    weak var anchorButton: NSStatusBarButton?

    private var lastDismissedAt = Date.distantPast
    private var isDismissing = false

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

        super.init()
        panel.delegate = self
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleDismissRequest), name: .threadDismissPanel, object: nil
        )
    }

    var isVisible: Bool { panel.isVisible }

    func toggle() {
        if panel.isVisible {
            dismiss()
        } else {
            // The menu-bar button click that got us here also resigned the panel's key status a
            // beat ago; without this guard that same click would reopen what it just closed.
            if Date().timeIntervalSince(lastDismissedAt) < 0.25 { return }
            show()
        }
    }

    func show() {
        position()
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }

    func dismiss() {
        guard panel.isVisible, !isDismissing else { return }
        isDismissing = true
        lastDismissedAt = Date()
        panel.orderOut(nil)
        isDismissing = false
    }

    @objc private func handleDismissRequest() { dismiss() }

    // MARK: NSWindowDelegate

    func windowDidResignKey(_ notification: Notification) {
        // Losing key to our own sheet (Settings / Add a conversation) must NOT dismiss the panel.
        if panel.attachedSheet != nil { return }
        if let key = NSApp.keyWindow, key.sheetParent === panel { return }
        dismiss()
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
