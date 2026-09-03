import AppKit
import UserNotifications

/// The "moment" half of the return nudge. The scored rule (`pickResumeSuggestion`) decides
/// *which* thread; this decides *when* — when you come back to an AI tool after a real gap, a
/// single quiet macOS notification, not a widget that's always on. A web app can't observe this.
///
/// Deliberately conservative: it fires at most once per cooldown window, only after you've been
/// away from every "thinking surface" for a while, only if the scored suggestion clears its
/// confidence floor, and never when a Focus filter has silenced it.
@MainActor
final class AmbientNudge: NSObject, UNUserNotificationCenterDelegate {
    private let appState: AppState

    private let returnGap: TimeInterval = 45 * 60      // "away" means at least this long
    private let cooldown: TimeInterval = 4 * 3600      // between notifications
    private let category = "thread.resume"

    private let lastActiveKey = "thread.ambient.lastThinkingActive"
    private let lastNotifiedKey = "thread.ambient.lastNotified"

    init(appState: AppState) {
        self.appState = appState
        super.init()
    }

    func start() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: category,
                actions: [
                    UNNotificationAction(identifier: "RESUME", title: "Resume", options: [.foreground]),
                    UNNotificationAction(identifier: "NOT_NOW", title: "Not now", options: []),
                ],
                intentIdentifiers: [], options: []
            )
        ])
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }

        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(appActivated(_:)),
            name: NSWorkspace.didActivateApplicationNotification, object: nil
        )
    }

    // MARK: - The moment

    @objc private func appActivated(_ note: Notification) {
        guard appState.isPaired, !appState.nudgesSilencedByFocus else { return }
        guard
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
            let bundleId = app.bundleIdentifier, bundleId != Bundle.main.bundleIdentifier
        else { return }
        guard isThinkingSurface(bundleId: bundleId, name: app.localizedName) else { return }

        let now = Date()
        let lastActive = date(forKey: lastActiveKey)
        let lastNotified = date(forKey: lastNotifiedKey)
        defer { UserDefaults.standard.set(now.timeIntervalSince1970, forKey: lastActiveKey) }

        guard ambientNudgeShouldFire(now: now, lastThinkingActive: lastActive,
                                     lastNotifiedAt: lastNotified,
                                     returnGap: returnGap, cooldown: cooldown) else { return }

        Task { await self.deliverIfWorthIt() }
    }

    private func deliverIfWorthIt() async {
        await appState.refresh()                       // pull anything new; cheap, local-first
        guard !appState.nudgesSilencedByFocus, let s = appState.resumeSuggestion else { return }

        appState.noteResumeShown(s.ideaId, lastActivity: appState.lastActivity(of: s.ideaId))
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: lastNotifiedKey)

        let content = UNMutableNotificationContent()
        content.title = "Unfinished thread"
        content.body = s.source.map { "\(s.title) — last in \($0), \(dayPhrase(s.daysAgo))" }
            ?? "\(s.title) — last worked on \(dayPhrase(s.daysAgo))"
        content.categoryIdentifier = category
        content.userInfo = ["ideaId": s.ideaId]

        try? await UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "thread.resume.\(s.ideaId)", content: content, trigger: nil)
        )
    }

    private func dayPhrase(_ d: Int) -> String { d <= 1 ? "1 day ago" : "\(d) days ago" }

    /// Browsers (where most AI use happens) and the AI desktop apps. Generous on purpose — a
    /// false positive here just means the gap/cooldown rule gets a chance to run.
    private func isThinkingSurface(bundleId: String, name: String?) -> Bool {
        let known: Set<String> = [
            "com.apple.Safari", "com.google.Chrome", "com.google.Chrome.canary",
            "company.thebrowser.Browser", "org.mozilla.firefox", "com.microsoft.edgemac",
            "com.brave.Browser", "com.vivaldi.Vivaldi", "com.operasoftware.Opera",
            "com.openai.chat", "com.anthropic.claudefordesktop", "com.anthropic.claude",
            "com.todesktop.230313mzl4w4u92", "dev.warp.Warp-Stable",
        ]
        if known.contains(bundleId) { return true }
        let hay = (bundleId + " " + (name ?? "")).lowercased()
        return ["chrome", "safari", "firefox", "arc", "chatgpt", "claude", "perplexity"]
            .contains { hay.contains($0) }
    }

    private func date(forKey key: String) -> Date? {
        let t = UserDefaults.standard.double(forKey: key)
        return t > 0 ? Date(timeIntervalSince1970: t) : nil
    }

    // MARK: - UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let ideaId = response.notification.request.content.userInfo["ideaId"] as? String ?? ""
        guard !ideaId.isEmpty else { return }
        await MainActor.run {
            switch response.actionIdentifier {
            case "NOT_NOW":
                appState.snoozeResume(ideaId)
            default: // tap or "Resume"
                appState.snoozeResume(ideaId)
                appState.perform(.continueIdea(ideaId))
            }
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}

/// Pure so the gap + cooldown gate is testable without AppKit. A "real return" = away from every
/// thinking surface for at least `returnGap`; "not nagging" = at least `cooldown` since the last
/// notification. First run (no history) passes both.
func ambientNudgeShouldFire(
    now: Date,
    lastThinkingActive: Date?,
    lastNotifiedAt: Date?,
    returnGap: TimeInterval,
    cooldown: TimeInterval
) -> Bool {
    let gapOK = lastThinkingActive.map { now.timeIntervalSince($0) >= returnGap } ?? true
    let cooldownOK = lastNotifiedAt.map { now.timeIntervalSince($0) >= cooldown } ?? true
    return gapOK && cooldownOK
}
