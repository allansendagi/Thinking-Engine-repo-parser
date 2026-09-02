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

/// Makes the green button fill the whole visible screen -- like ChatGPT and most modern Mac
/// apps -- instead of AppKit's "zoom to the content's ideal size", which left a grey void.
///
/// Two paths cover it: (1) the zoom BUTTON's action is replaced so a click toggles between the
/// full `visibleFrame` and the prior size; (2) `windowWillUseStandardFrame` handles the other
/// zoom entry points (double-click titlebar, Window menu). Chains to any delegate SwiftUI set.
final class WindowChrome: NSObject, NSWindowDelegate {
    weak var window: NSWindow?
    weak var forward: NSWindowDelegate?
    private var restoreFrame: NSRect?

    private func fullFrame(_ w: NSWindow) -> NSRect { (w.screen ?? NSScreen.main)?.visibleFrame ?? w.frame }

    @objc func toggleFill(_ sender: Any?) {
        guard let w = window else { return }
        let full = fullFrame(w)
        if let r = restoreFrame,
           abs(w.frame.width - full.width) < 2, abs(w.frame.height - full.height) < 2 {
            w.setFrame(r, display: true, animate: true)
            restoreFrame = nil
        } else {
            restoreFrame = w.frame
            w.setFrame(full, display: true, animate: true)
        }
    }

    func windowWillUseStandardFrame(_ window: NSWindow, defaultFrame newFrame: NSRect) -> NSRect {
        fullFrame(window)
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || (forward?.responds(to: aSelector) ?? false)
    }
    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        super.responds(to: aSelector) ? self : forward
    }
}

/// NSWindow.delegate is weak, and the zoom button holds only a weak target -- retain per window.
private var windowChromeStore: [ObjectIdentifier: WindowChrome] = [:]

extension View {
    /// Standard full-window configuration: green button fills the screen, resizable, full-screen
    /// capable, non-restorable, no window tabbing.
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
                chrome.window = w
                if w.delegate !== chrome {
                    chrome.forward = w.delegate
                    w.delegate = chrome
                }
                if let zoom = w.standardWindowButton(.zoomButton), zoom.target !== chrome {
                    zoom.target = chrome
                    zoom.action = #selector(WindowChrome.toggleFill(_:))
                }
            }
        )
    }
}
