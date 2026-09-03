import SwiftUI
import AppKit

/// Reaches the hosting NSWindow so we can set things SwiftUI's `Window` scene doesn't expose:
/// full-screen capability (the green button only "zooms" otherwise), a real resizable style
/// mask, and disabling state restoration (so the window doesn't silently reopen on next launch
/// and read as "clicking the menu-bar icon opened the big window").
struct WindowAccessor: NSViewRepresentable {
    let configure: (NSWindow) -> Void

    /// A view that fires `configure` the moment it's attached to a window -- reliable, unlike the
    /// old `DispatchQueue.main.async { view.window }` dance whose timing wasn't guaranteed.
    final class Reader: NSView {
        var configure: ((NSWindow) -> Void)?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let w = window { configure?(w) }
        }
    }

    func makeNSView(context: Context) -> Reader {
        let v = Reader()
        v.configure = configure
        return v
    }

    func updateNSView(_ nsView: Reader, context: Context) {
        nsView.configure = configure
        if let w = nsView.window { configure(w) }
    }
}

/// Per-window delegate. A plain green-button click (or Window ▸ Zoom) is intercepted in
/// `windowShouldZoom` and turned into real full-screen -- covers the whole display, menu bar
/// auto-hides. Hold Option while clicking the green button for an ordinary maximise-to-screen.
///
/// It also flips the app to `.regular` activation policy while the window lives. THIS is why the
/// green/zoom/full-screen buttons did nothing before: Thread is an `LSUIElement` (accessory) app,
/// and macOS won't let an accessory app enter full-screen or properly zoom -- it silently no-ops.
/// A temporary Dock icon + app menu is the price of a full-screen-capable window.
final class WindowChrome: NSObject, NSWindowDelegate {
    weak var forward: NSWindowDelegate?

    func windowShouldZoom(_ window: NSWindow, toFrame newFrame: NSRect) -> Bool {
        if NSApp.currentEvent?.modifierFlags.contains(.option) == true {
            return true   // option-click: normal zoom to the visible frame (see below)
        }
        window.toggleFullScreen(nil)
        return false      // don't also do the resize
    }

    func windowWillUseStandardFrame(_ window: NSWindow, defaultFrame newFrame: NSRect) -> NSRect {
        (window.screen ?? NSScreen.main)?.visibleFrame ?? newFrame
    }

    func windowWillClose(_ notification: Notification) {
        // Back to a menu-bar-only agent once the window is gone.
        DispatchQueue.main.async {
            if !NSApp.windows.contains(where: { $0.isVisible && $0.canBecomeMain && $0 !== (notification.object as? NSWindow) }) {
                NSApp.setActivationPolicy(.accessory)
            }
        }
        forward?.windowWillClose?(notification)
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || (forward?.responds(to: aSelector) ?? false)
    }
    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        super.responds(to: aSelector) ? self : forward
    }
}

/// NSWindow.delegate is weak -- retain the chrome per window.
private var windowChromeStore: [ObjectIdentifier: WindowChrome] = [:]

extension View {
    /// Full-window configuration. Two root-cause fixes live here:
    ///
    /// 1. **Content hidden under a white band.** `NavigationSplitView` on macOS gives a
    ///    translucent, full-height (`fullSizeContentView`) titlebar and only insets a *`List`'s*
    ///    safe area beneath it. Our columns are custom `VStack`/`ScrollView`s, so their content
    ///    drew straight under the ~52pt titlebar and the titlebar's translucent band covered the
    ///    search field and the detail title. Forcing a normal opaque, non-full-size titlebar makes
    ///    AppKit inset the content view below it -- no magic top-padding needed.
    ///
    /// 2. **Green button only "zoomed", never full-screened.** A SwiftUI `Window` scene's zoom
    ///    button resizes to a standard frame; it does not enter real macOS full-screen. Remapping
    ///    its action to `toggleFullScreen:` (with `.fullScreenPrimary` set) is the AppKit-blessed
    ///    way to make the green button cover the whole display and auto-hide the menu bar.
    func fullWindowChrome() -> some View {
        background(
            WindowAccessor { w in
                // Accessory (LSUIElement) apps can't enter full-screen -- promote to a regular app
                // while this window is up so the green button actually works. WindowChrome drops
                // back to .accessory when it closes.
                if NSApp.activationPolicy() != .regular {
                    NSApp.setActivationPolicy(.regular)
                    NSApp.activate(ignoringOtherApps: true)
                }

                w.collectionBehavior.insert(.fullScreenPrimary)
                w.isRestorable = false
                w.tabbingMode = .disallowed
                w.isMovableByWindowBackground = false

                w.styleMask.remove(.fullSizeContentView)
                w.titlebarAppearsTransparent = false
                w.titleVisibility = .visible

                let key = ObjectIdentifier(w)
                let chrome = windowChromeStore[key] ?? {
                    let c = WindowChrome()
                    windowChromeStore[key] = c
                    return c
                }()
                if w.delegate !== chrome {
                    chrome.forward = w.delegate
                    w.delegate = chrome
                }
            }
        )
    }
}
