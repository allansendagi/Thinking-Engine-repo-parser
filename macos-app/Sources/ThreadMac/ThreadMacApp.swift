import SwiftUI
import Carbon.HIToolbox

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    /// So App Intents (which the system instantiates on their own) can reach the running
    /// app's single AppState. Set on init; the app is a lone menu-bar process, never > 1.
    static private(set) weak var shared: AppDelegate?

    let appState = AppState()
    private var hotKey: GlobalHotKey?
    private var quickRecallPanel: QuickRecallPanel?
    private var pairingServer: PairingServer?
    private var statusItem: NSStatusItem?
    private var servicesProvider: ThreadServicesProvider?
    /// `thread://` URLs that arrived before the panel existed (cold launch via `open`).
    private var pendingURLs: [URL] = []

    override init() {
        super.init()
        AppDelegate.shared = self
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let panel = QuickRecallPanel(appState: appState)
        quickRecallPanel = panel

        // Bring the panel up on request (thread:// scheme, Services menu, App Intents later).
        NotificationCenter.default.addObserver(
            self, selector: #selector(presentPanel), name: .threadPresentPanel, object: nil
        )

        // "Recall in Thread" on selected text in any app.
        let services = ThreadServicesProvider(appState: appState)
        NSApp.servicesProvider = services
        servicesProvider = services

        // Menu-bar item. `statusItem.menu` is attached -- that's the only reliable way to get a
        // right-click menu on an NSStatusBarButton (its action never sees right-mouse events, and
        // sendAction(on:) / event-monitor tricks proved flaky across machines). A plain LEFT click
        // is intercepted in menuWillOpen: the menu is cancelled before it shows and the panel
        // toggles instead. So: left-click -> panel, right-click / ctrl-click -> menu.
        // (A SwiftUI MenuBarExtra would create a second RootView window, which is what made it
        // "jump", so this stays hand-rolled.)
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = BrandMark.menuBarImage
        item.menu = statusMenu
        statusItem = item
        panel.anchorButton = item.button

        // Cmd+Shift+T opens the same panel.
        hotKey = GlobalHotKey(keyCode: UInt32(kVK_ANSI_T), modifiers: UInt32(cmdKey | shiftKey)) { [weak panel] in
            panel?.toggle()
        }
        if hotKey == nil {
            print("[ThreadMac] Failed to register the global hotkey (Cmd+Shift+T) -- it may be in use by another app.")
        }

        let state = appState
        let server = PairingServer(
            // Only serve the token while a pairing window is open (see AppState.openPairingWindow).
            payloadProvider: { state.isPairingWindowOpen ? state.pairingPayload() : nil },
            onServed: { Task { @MainActor in state.noteExtensionHandshake() } }
        )
        server.start()
        pairingServer = server
        // A short window on launch so a freshly-installed extension pairs with no clicks.
        appState.openPairingWindow(seconds: 120)

        Task { await appState.bootstrap() }

        // Flush any thread:// URL that launched us before this point.
        let queued = pendingURLs
        pendingURLs.removeAll()
        queued.forEach(route)

        // The menu-bar panel is the ONLY thing that should be up at launch. `.defaultLaunchBehavior
        // (.suppressed)` on the Window scene should already stop the big window auto-presenting, but
        // it's not reliable for a single-Window app across macOS versions -- so also close it by
        // hand for the first moment after launch. Deliberate opens ("Open in Window", ⌘⇧W) happen
        // seconds later, well after this guard lapses.
        let deadline = Date().addingTimeInterval(1.5)
        func sweep() {
            guard Date() < deadline else { return }
            for w in NSApp.windows where !(w is NSPanel) && w.styleMask.contains(.titled) && w.isVisible {
                w.orderOut(nil)   // hide, don't close -- keeps the scene alive for a later openWindow(id:)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: sweep)
        }
        DispatchQueue.main.async(execute: sweep)
    }

    /// `open thread://...` from Raycast / Alfred / Shortcuts / a script. Registered via
    /// `CFBundleURLTypes` in the bundle's Info.plist.
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            if quickRecallPanel == nil { pendingURLs.append(url) } else { route(url) }
        }
    }

    private func route(_ url: URL) {
        guard let action = ThreadAction.parse(url) else {
            print("[ThreadMac] ignored unrecognised URL: \(url.absoluteString)")
            return
        }
        appState.perform(action)
    }

    // MARK: - Status-item menu

    private lazy var statusMenu: NSMenu = {
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        let add = { (title: String, sel: Selector, key: String, mods: NSEvent.ModifierFlags) -> NSMenuItem in
            let mi = NSMenuItem(title: title, action: sel, keyEquivalent: key)
            mi.keyEquivalentModifierMask = mods
            mi.target = self
            menu.addItem(mi)
            return mi
        }
        _ = add("Open Thread", #selector(presentPanel), "", [])
        _ = add("Open in Window", #selector(openMainWindowFromMenu), "w", [.command, .shift])
        _ = add("Settings…", #selector(openSettingsFromMenu), ",", [.command])
        menu.addItem(.separator())
        signOutMenuItem = add("Sign Out", #selector(signOutFromMenu), "", [])
        menu.addItem(.separator())
        _ = add("Quit Thread", #selector(quitFromMenu), "q", [.command])
        return menu
    }()

    private weak var signOutMenuItem: NSMenuItem?

    @objc private func presentPanel() { quickRecallPanel?.show() }
    @objc private func openMainWindowFromMenu() {
        NSApp.activate(ignoringOtherApps: true)
        NotificationCenter.default.post(name: .threadOpenMainWindow, object: nil)
    }
    @objc private func openSettingsFromMenu() {
        quickRecallPanel?.show()
        NotificationCenter.default.post(name: .threadOpenSettings, object: nil)
    }
    @objc private func signOutFromMenu() { appState.unpair() }
    @objc private func quitFromMenu() { NSApp.terminate(nil) }

    /// Sign Out only makes sense while there's an account attached to this Mac.
    func menuNeedsUpdate(_ menu: NSMenu) {
        signOutMenuItem?.isEnabled = appState.isPaired
    }

    /// `statusItem.menu` is set so right-click reliably drops the menu. But a plain LEFT click
    /// should just toggle the panel -- so catch it here, cancel the menu before it appears, and
    /// toggle instead. Right-click / ctrl-click fall through and open the menu normally.
    func menuWillOpen(_ menu: NSMenu) {
        guard let event = NSApp.currentEvent else { return }
        let plainLeftClick = (event.type == .leftMouseDown || event.type == .leftMouseUp)
            && !event.modifierFlags.contains(.control)
        if plainLeftClick {
            menu.cancelTrackingWithoutAnimation()
            DispatchQueue.main.async { [weak self] in self?.quickRecallPanel?.toggle() }
        }
    }

    /// The quick-recall panel is an NSPanel, which AppKit doesn't count as a "visible window", so
    /// activating the app (Dock click, status-item click) would otherwise trigger the default
    /// reopen behavior and pop the big window open unbidden. The big window is only ever opened
    /// deliberately -- "Open in Window" or Cmd+Shift+W.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        false
    }

    /// Thread lives in the menu bar. Closing the full window -- whether by the user or by the
    /// launch sweep below -- must NOT quit the app. Without this a SwiftUI app terminates when
    /// its last scene window closes.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationWillTerminate(_ notification: Notification) {
        pairingServer?.stop()
    }
}

@main
struct ThreadMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        // The optional Full Window (spec §4). Thread is menu-bar-first: this window is opened
        // deliberately -- "Open in Window", Cmd+Shift+W, or a thread:// URL -- never at launch.
        // `.defaultLaunchBehavior(.suppressed)` is what stops a SwiftUI `Window` scene from
        // presenting itself on every cold start (LSUIElement hides the Dock icon but does NOT
        // suppress the scene). Programmatic `openWindow(id: "main")` still works. Single instance.
        Window("Thread", id: "main") {
            MainWindowView()
                .environmentObject(appDelegate.appState)
        }
        .defaultLaunchBehavior(.suppressed)
        .keyboardShortcut("w", modifiers: [.command, .shift])
        .defaultSize(width: 1180, height: 760)
        // Respect the view's minWidth/minHeight but let the window grow to any size, zoom (green
        // button), and go full-screen. Without this a `Window` scene can lock to its content's
        // ideal size and the maximise button does nothing.
        .windowResizability(.contentMinSize)
    }
}
