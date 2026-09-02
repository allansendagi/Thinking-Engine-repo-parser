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

/// Makes the green button fill the whole screen -- like ChatGPT and most modern Mac apps --
/// instead of AppKit's default "zoom to the content's ideal size", which leaves a grey void.
/// `windowWillUseStandardFrame` is the sanctioned hook; we chain to whatever delegate SwiftUI
/// already set so nothing else regresses.
final class FillScreenDelegate: NSObject, NSWindowDelegate {
    weak var forward: NSWindowDelegate?

    func windowWillUseStandardFrame(_ window: NSWindow, defaultFrame newFrame: NSRect) -> NSRect {
        window.screen?.visibleFrame ?? newFrame
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || (forward?.responds(to: aSelector) ?? false)
    }
    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        super.responds(to: aSelector) ? self : forward
    }
}

/// NSWindow.delegate is weak, so the FillScreenDelegate for each window has to be retained here.
private var fillScreenDelegates: [ObjectIdentifier: FillScreenDelegate] = [:]

extension View {
    /// Applies the standard full-window configuration: green button fills the screen, resizable,
    /// full-screen capable, non-restorable, no window tabbing.
    func fullWindowChrome() -> some View {
        background(
            WindowAccessor { w in
                w.styleMask.insert([.resizable, .miniaturizable, .closable, .titled])
                w.collectionBehavior.insert(.fullScreenPrimary)
                w.isRestorable = false
                w.tabbingMode = .disallowed
                w.isMovableByWindowBackground = false

                let key = ObjectIdentifier(w)
                if fillScreenDelegates[key] == nil {
                    let d = FillScreenDelegate()
                    d.forward = w.delegate
                    fillScreenDelegates[key] = d
                    w.delegate = d
                }
            }
        )
    }
}
