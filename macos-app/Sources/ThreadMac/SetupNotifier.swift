import AppKit
import UserNotifications

/// Tells the user, in one macOS notification, exactly what Thread needs from them right now --
/// a permission to grant, an account to connect, a capture path that broke -- with the literal
/// steps in the body. Thread is a menu-bar app (`LSUIElement`), so an in-app banner alone can sit
/// unseen; this is the push that reaches them.
///
/// One notification per distinct blocker, once, until it clears. A blocker that resolves re-arms,
/// so a *new* break after a clean stretch notifies again rather than staying silent. No custom
/// actions or categories -- it shares the notification centre with `AmbientNudge`, which owns the
/// delegate; keeping this one plain avoids fighting over it.
@MainActor
final class SetupNotifier {
    enum Blocker: Equatable {
        case accessibilityNeeded
        case notPaired
        case captureError(String)

        var id: String {
            switch self {
            case .accessibilityNeeded: return "accessibility"
            case .notPaired: return "notPaired"
            case .captureError: return "captureError"
            }
        }
        var title: String {
            switch self {
            case .accessibilityNeeded: return "Thread needs Accessibility access"
            case .notPaired: return "Finish connecting Thread"
            case .captureError: return "Thread hit a capture problem"
            }
        }
        var body: String {
            switch self {
            case .accessibilityNeeded:
                return "To read the AI apps on this Mac, turn Thread on in System Settings > "
                    + "Privacy & Security > Accessibility, then relaunch Thread. A fresh install "
                    + "is a new entry in that list."
            case .notPaired:
                return "Open Thread from the menu-bar icon and connect your account -- until then "
                    + "it can read your AI apps but has nowhere to save what it finds."
            case .captureError(let detail):
                return detail
            }
        }
    }

    private let deliveredKey = "thread.setup.deliveredBlockers"

    func start() {
        // Additive with AmbientNudge's request; harmless if it already granted.
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) { _, _ in }
    }

    /// Notify about `blocker` -- once per distinct blocker until it's `clear`ed. Never auto-clears
    /// other blockers: they're independent (a missing permission and an unconnected account are
    /// not resolved by each other), and blanket-clearing turns any state change into a re-nag.
    func report(_ blocker: Blocker) {
        var delivered = Set(UserDefaults.standard.stringArray(forKey: deliveredKey) ?? [])
        guard !delivered.contains(blocker.id) else { return }
        delivered.insert(blocker.id)
        UserDefaults.standard.set(Array(delivered), forKey: deliveredKey)

        print("[ThreadMac setup] \(blocker.title) -- \(blocker.body)")

        let content = UNMutableNotificationContent()
        content.title = blocker.title
        content.body = blocker.body
        Task {
            try? await UNUserNotificationCenter.current().add(
                UNNotificationRequest(identifier: "thread.setup.\(blocker.id)", content: content, trigger: nil)
            )
        }
    }

    /// Mark `blocker` resolved, so it can notify again if it later recurs. Call this only from a
    /// state that actually proves it's resolved (e.g. the sensor reaching `.watching` proves
    /// Accessibility is granted -- but says nothing about the account).
    func clear(_ blocker: Blocker) {
        var delivered = Set(UserDefaults.standard.stringArray(forKey: deliveredKey) ?? [])
        guard delivered.remove(blocker.id) != nil else { return }
        UserDefaults.standard.set(Array(delivered), forKey: deliveredKey)
    }
}
