import AppKit

/// "Quit Thread" must always quit.
///
/// AppKit's `terminate(_:)` is a polite request: it routes through the app delegate and any
/// attached sheet or modal session, and anything that doesn't answer leaves the app running with
/// no sign that the click did anything. For a menu-bar app, where Quit is the only way out, that
/// is the one failure that cannot happen -- so ask politely first, and if the app is still alive a
/// moment later, end the process. Everything Thread keeps is saved as it changes, and its local
/// sockets are released by the OS when the process ends.
enum AppQuit {
    @MainActor
    static func now(forceAfter seconds: Double = 2) {
        NSApp.terminate(nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { exit(0) }
    }
}
