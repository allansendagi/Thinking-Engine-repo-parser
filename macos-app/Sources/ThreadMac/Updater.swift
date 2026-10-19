import AppKit
import Sparkle

/// Auto-updates via Sparkle 2, silently: checks the appcast hourly, downloads in the background,
/// verifies the EdDSA signature against `SUPublicEDKey`, and installs by itself -- right away when
/// none of Thread's windows are open, otherwise the moment the last one closes (or on quit). No
/// dialog: a menu-bar app's update alert opens behind other windows and is easy to never see,
/// which left people on old builds until they re-downloaded the DMG.
///
/// Inert unless the bundle's Info.plist carries both `SUFeedURL` and `SUPublicEDKey`, which
/// `package.sh` writes only when `THREAD_SPARKLE_PUBLIC_KEY` is set (see README ▸ Releases). A
/// dev build (`swift run`, or packaging without a key) never prompts, never phones home, and the
/// "Check for Updates…" menu item stays hidden.
@MainActor
final class Updater: NSObject, SPUStandardUserDriverDelegate, SPUUpdaterDelegate {
    private var controller: SPUStandardUpdaterController?
    /// A downloaded update waiting for a quiet moment to install (see `installWhenQuiet`).
    private var pendingInstall: (() -> Void)?
    private var windowObserver: NSObjectProtocol?

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
            startingUpdater: true, updaterDelegate: self, userDriverDelegate: self
        )
        // Silent updates (also set in Info.plist by package.sh): an older install's saved
        // preference can't keep it on prompts.
        controller?.updater.automaticallyChecksForUpdates = true
        controller?.updater.automaticallyDownloadsUpdates = true
    }

    // MARK: SPUUpdaterDelegate

    /// An update is downloaded and verified. Install it now if no Thread window is open (the
    /// person isn't using it), else as soon as the last window closes; quitting installs it too.
    nonisolated func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem, immediateInstallationBlock: @escaping () -> Void) -> Bool {
        Task { @MainActor in self.installWhenQuiet(immediateInstallationBlock) }
        return true
    }

    private func installWhenQuiet(_ install: @escaping () -> Void) {
        pendingInstall = install
        if !hasVisibleWindow() {
            runPendingInstall()
            return
        }
        guard windowObserver == nil else { return }
        windowObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification, object: nil, queue: .main
        ) { [weak self] _ in
            // willClose fires before the window is gone: look again on the next turn.
            DispatchQueue.main.async {
                Task { @MainActor in
                    guard let self, !self.hasVisibleWindow() else { return }
                    self.runPendingInstall()
                }
            }
        }
    }

    private func runPendingInstall() {
        if let o = windowObserver { NotificationCenter.default.removeObserver(o) }
        windowObserver = nil
        let install = pendingInstall
        pendingInstall = nil
        install?()
    }

    /// A window the person can see (the menu-bar panel or the main window), not the status item.
    private func hasVisibleWindow() -> Bool {
        NSApp.windows.contains { $0.isVisible && $0.level != .statusBar && !$0.className.contains("StatusBar") && $0.frame.width > 40 }
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
