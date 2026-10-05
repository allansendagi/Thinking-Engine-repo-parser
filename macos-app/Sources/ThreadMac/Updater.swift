import AppKit
import Sparkle

/// Auto-updates via Sparkle 2: checks the appcast daily in the background, downloads, verifies
/// the EdDSA signature against `SUPublicEDKey`, and installs on relaunch -- so a fix reaches every
/// user without anyone re-downloading the DMG.
///
/// Inert unless the bundle's Info.plist carries both `SUFeedURL` and `SUPublicEDKey`, which
/// `package.sh` writes only when `THREAD_SPARKLE_PUBLIC_KEY` is set (see README ▸ Releases). A
/// dev build (`swift run`, or packaging without a key) never prompts, never phones home, and the
/// "Check for Updates…" menu item stays hidden.
@MainActor
final class Updater: NSObject, SPUStandardUserDriverDelegate {
    private var controller: SPUStandardUpdaterController?

    var isConfigured: Bool {
        let info = Bundle.main.infoDictionary ?? [:]
        let feed = (info["SUFeedURL"] as? String) ?? ""
        let key = (info["SUPublicEDKey"] as? String) ?? ""
        return !feed.isEmpty && !key.isEmpty
    }

    var canCheckForUpdates: Bool { controller?.updater.canCheckForUpdates ?? false }

    var automaticallyChecks: Bool {
        get { controller?.updater.automaticallyChecksForUpdates ?? false }
        set { controller?.updater.automaticallyChecksForUpdates = newValue }
    }

    func start() {
        guard isConfigured, controller == nil else { return }
        controller = SPUStandardUpdaterController(
            startingUpdater: true, updaterDelegate: nil, userDriverDelegate: self
        )
    }

    func checkForUpdates() {
        guard let controller else { return }
        // Menu-bar app: without activating, Sparkle's window opens behind whatever is frontmost.
        NSApp.activate(ignoringOtherApps: true)
        controller.checkForUpdates(nil)
    }

    // A background (LSUIElement) app should surface scheduled updates gently rather than
    // stealing focus; Sparkle asks apps like this to opt in explicitly.
    nonisolated var supportsGentleScheduledUpdateReminders: Bool { true }
}
