import SwiftUI
import Carbon.HIToolbox

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let appState = AppState()
    private var hotKey: GlobalHotKey?
    private var quickRecallPanel: QuickRecallPanel?
    private var pairingServer: PairingServer?
    private var statusItem: NSStatusItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let panel = QuickRecallPanel(appState: appState)
        quickRecallPanel = panel

        // Menu-bar item — a single NSStatusItem whose click toggles the ONE panel. (A SwiftUI
        // MenuBarExtra would create a second RootView window, which is what made it "jump".)
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = BrandMark.menuBarImage
        item.button?.action = #selector(togglePanel)
        item.button?.target = self
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
            payloadProvider: { state.pairingPayload() },
            onServed: { Task { @MainActor in state.noteExtensionHandshake() } }
        )
        server.start()
        pairingServer = server

        Task { await appState.bootstrap() }
    }

    @objc private func togglePanel() { quickRecallPanel?.toggle() }

    func applicationWillTerminate(_ notification: Notification) {
        pairingServer?.stop()
    }
}

@main
struct ThreadMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        // The optional Full Window (spec §4). Opened with "Open in Window" from the panel, or
        // Cmd+Shift+W. Single instance.
        Window("Thread", id: "main") {
            MainWindowView()
                .environmentObject(appDelegate.appState)
        }
        .keyboardShortcut("w", modifiers: [.command, .shift])
    }
}
