import SwiftUI
import Carbon.HIToolbox

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let appState = AppState()
    private var hotKey: GlobalHotKey?
    private var quickRecallPanel: QuickRecallPanel?
    private var pairingServer: PairingServer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let panel = QuickRecallPanel(appState: appState)
        quickRecallPanel = panel

        // Default: Cmd+Shift+T. kVK_ANSI_T = 0x11. Not user-configurable yet -- see README.
        hotKey = GlobalHotKey(keyCode: UInt32(kVK_ANSI_T), modifiers: UInt32(cmdKey | shiftKey)) {
            panel.toggle()
        }
        if hotKey == nil {
            print("[ThreadMac] Failed to register the global hotkey (Cmd+Shift+T) -- it may be in use by another app.")
        }

        // Serve credentials to the browser extension over loopback so it never mints its own
        // account. Started before bootstrap so a fast extension retry catches a fresh account.
        let state = appState
        let server = PairingServer(
            payloadProvider: { state.pairingPayload() },
            onServed: { Task { @MainActor in state.noteExtensionHandshake() } }
        )
        server.start()
        pairingServer = server

        Task { await appState.bootstrap() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        pairingServer?.stop()
    }
}

@main
struct ThreadMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        MenuBarExtra {
            RootView()
                .environmentObject(appDelegate.appState)
        } label: {
            MenuBarGlyph()
        }
        .menuBarExtraStyle(.window)

        // The optional Full Window (spec §4). Opened with "Open in Window" from the panel, or
        // Cmd+Shift+W. Single instance.
        Window("Thread", id: "main") {
            MainWindowView()
                .environmentObject(appDelegate.appState)
        }
        .keyboardShortcut("w", modifiers: [.command, .shift])
    }
}
