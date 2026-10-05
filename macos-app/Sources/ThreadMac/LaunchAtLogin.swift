import Foundation
import ServiceManagement

/// "Open at login" via `SMAppService.mainApp` (macOS 13+). A menu-bar app that isn't running
/// after a restart silently stops capturing (Cursor watch, extension pairing), so Thread turns
/// this on once, on its first launch from a real app bundle; after that it's the user's toggle
/// in Settings and is never forced back on.
enum LaunchAtLogin {
    private static let didAutoEnableKey = "thread.launchAtLogin.autoEnabled"

    static var isEnabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    /// True when macOS wants the user to approve the login item in System Settings.
    static var needsApproval: Bool {
        SMAppService.mainApp.status == .requiresApproval
    }

    @discardableResult
    static func setEnabled(_ enabled: Bool) -> Bool {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            return true
        } catch {
            print("[ThreadMac] launch-at-login \(enabled ? "register" : "unregister") failed: \(error)")
            return false
        }
    }

    /// First run only, and only from an installed .app (not `swift run` / a raw binary, which
    /// would register a login item pointing at a build directory).
    static func enableOnFirstLaunchIfNeeded() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: didAutoEnableKey) else { return }
        guard Bundle.main.bundleURL.pathExtension == "app" else { return }
        defaults.set(true, forKey: didAutoEnableKey)
        if !isEnabled { setEnabled(true) }
    }

    static func openSystemSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}
