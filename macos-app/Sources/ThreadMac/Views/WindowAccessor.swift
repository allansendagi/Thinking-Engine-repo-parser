import SwiftUI
import AppKit

/// Reaches the hosting NSWindow so we can set things SwiftUI's `Window` scene doesn't expose:
/// full-screen capability (the green button only "zooms" otherwise), a real resizable style
/// mask, and disabling state restoration (so the window doesn't silently reopen on next launch
/// and read as "clicking the menu-bar icon opened the big window").
struct WindowAccessor: NSViewRepresentable {
    let configure: (NSWindow) -> Void

    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        DispatchQueue.main.async { [weak v] in v?.window.map(configure) }
        return v
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async { [weak nsView] in nsView?.window.map(configure) }
    }
}

/// Native window behaviour, like Notes/Finder: a plain click on the green button zooms the window
/// to fill the visible screen (menu bar stays), and its hover menu still offers "Enter Full
/// Screen" / Tile because we keep `.fullScreenPrimary`. `windowWillUseStandardFrame` returning
/// the screen's visible frame is all it takes to make the plain-click zoom fill the display --
/// we do NOT override the zoom button's action (that broke the titlebar rendering).
final class WindowChrome: NSObject, NSWindowDelegate {
    weak var forward: NSWindowDelegate?

    func windowWillUseStandardFrame(_ window: NSWindow, defaultFrame newFrame: NSRect) -> NSRect {
        (window.screen ?? NSScreen.main)?.visibleFrame ?? newFrame
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
    /// Full-window config: full-screen capable, non-restorable, no tabbing, and a delegate so the
    /// green-button zoom fills the visible screen. Deliberately leaves the style mask and the zoom
    /// button's action ALONE -- SwiftUI's `Window` scene already gives a proper titled/resizable
    /// window, and overriding the zoom action was what made the titlebar render broken.
    func fullWindowChrome() -> some View {
        background(
            WindowAccessor { w in
                w.collectionBehavior.insert(.fullScreenPrimary)
                w.isRestorable = false
                w.tabbingMode = .disallowed
                w.isMovableByWindowBackground = false

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
