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

extension View {
    /// Applies the standard full-window configuration: zoom/full-screen enabled, resizable,
    /// non-restorable, no window tabbing.
    func fullWindowChrome() -> some View {
        background(
            WindowAccessor { w in
                w.styleMask.insert([.resizable, .miniaturizable, .closable, .titled])
                w.collectionBehavior.insert(.fullScreenPrimary)
                w.isRestorable = false
                w.tabbingMode = .disallowed
                w.isMovableByWindowBackground = false
            }
        )
    }
}
