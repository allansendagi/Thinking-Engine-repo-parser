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

/// Makes the green button enter real macOS full-screen -- menu bar hidden, the window covering
/// the entire display -- the way ChatGPT and most modern Mac apps behave. `.fullScreenPrimary`
/// alone often leaves a SwiftUI single-`Window` scene still just "zooming", so the zoom button's
/// action is set explicitly to `toggleFullScreen:`. `windowWillUseStandardFrame` keeps the
/// non-full-screen zoom paths (option-click, Window menu) maximising to the visible frame.
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
    /// Standard full-window configuration: green button enters full-screen, resizable,
    /// non-restorable, no window tabbing.
    func fullWindowChrome() -> some View {
        background(
            WindowAccessor { w in
                w.styleMask.insert([.resizable, .miniaturizable, .closable, .titled])
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
                // Green button -> real full-screen (covers the whole display, hides the menu bar).
                if let zoom = w.standardWindowButton(.zoomButton),
                   zoom.action != #selector(NSWindow.toggleFullScreen(_:)) {
                    zoom.target = w
                    zoom.action = #selector(NSWindow.toggleFullScreen(_:))
                }
            }
        )
    }
}
