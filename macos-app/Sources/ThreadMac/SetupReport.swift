import AppKit

/// What this Mac's setup looks like, sent to the account so "opened Thread but nothing was ever
/// captured" has a reason (server: src/api/setupReport.ts). Content-free by construction: yes/no,
/// small counts, and names from fixed lists -- never a conversation, a file path, a window title or
/// when an app was used. The server drops anything outside these fields and keeps only the latest.
struct SetupReport: Encodable, Equatable {
    var extensionEverConnected: Bool
    var extensionLastSeenMinutes: Int?
    var defaultBrowser: String?
    var extensionBrowsersInstalled: [String]
    var aiAppsInstalled: [String]
    var cursorHistoryFound: Bool
    var localSourcesFound: [String]
    var accessibilityGranted: Bool
    var blockers: [String]
    var pendingCaptures: Int
    /// "Recover my thinking" was started / ran to the end on this Mac.
    var recoveryStarted: Bool = false
    var recoveryFinished: Bool = false

    /// Browser bundle ids -> the names the server knows. Only the first three run the extension
    /// (`extensionBrowserBundleIDs`).
    static let browserNames: [(id: String, name: String)] = [
        ("com.google.Chrome", "chrome"), ("com.brave.Browser", "brave"), ("company.thebrowser.Browser", "arc"),
        ("com.microsoft.edgemac", "edge"), ("com.apple.Safari", "safari"), ("org.mozilla.firefox", "firefox"),
    ]
    /// Desktop AI apps -> names. ChatGPT ships under either id; Claude under either id.
    static let aiApps: [(ids: [String], name: String)] = [
        (["com.todesktop.230313mzl4w4u92"], "cursor"),
        (["com.openai.chat", "com.openai.codex"], "chatgpt"),
        (["com.anthropic.claudefordesktop", "com.anthropic.claude"], "claude"),
    ]

    /// Pure: everything the Mac observed, in, the report out. `installed` answers "is this bundle id
    /// installed?"; `defaultBrowserID` is the bundle id that opens https links.
    static func make(
        lastExtensionPing: Date?,
        now: Date,
        defaultBrowserID: String?,
        installed: (String) -> Bool,
        cursorHistoryFound: Bool,
        localSourcesFound: [String],
        accessibilityGranted: Bool,
        blockers: [String],
        pendingCaptures: Int,
        recoveryStarted: Bool = false,
        recoveryFinished: Bool = false
    ) -> SetupReport {
        let defaultName = defaultBrowserID.map { id in browserNames.first(where: { $0.id == id })?.name ?? "other" }
        return SetupReport(
            extensionEverConnected: lastExtensionPing != nil,
            extensionLastSeenMinutes: lastExtensionPing.map { max(0, Int(now.timeIntervalSince($0) / 60)) },
            defaultBrowser: defaultName,
            extensionBrowsersInstalled: browserNames.filter { extensionBrowserBundleIDs.contains($0.id) && installed($0.id) }.map(\.name),
            aiAppsInstalled: aiApps.filter { $0.ids.contains(where: installed) }.map(\.name),
            cursorHistoryFound: cursorHistoryFound,
            localSourcesFound: localSourcesFound.sorted(),
            accessibilityGranted: accessibilityGranted,
            blockers: blockers.sorted(),
            pendingCaptures: pendingCaptures,
            recoveryStarted: recoveryStarted,
            recoveryFinished: recoveryFinished
        )
    }

    /// The report for this Mac, right now.
    @MainActor
    static func current(appState: AppState) -> SetupReport {
        let workspace = NSWorkspace.shared
        let fm = FileManager.default
        return make(
            lastExtensionPing: appState.lastExtensionPing,
            now: Date(),
            defaultBrowserID: URL(string: "https://example.com").flatMap { workspace.urlForApplication(toOpen: $0) }.flatMap { Bundle(url: $0)?.bundleIdentifier },
            installed: { workspace.urlForApplication(withBundleIdentifier: $0) != nil },
            cursorHistoryFound: CursorBackfill.available,
            localSourcesFound: LocalHistorySources.all.filter { $0.roots.contains(where: { fm.fileExists(atPath: $0) }) }.map(\.source),
            accessibilityGranted: AXSensorRunner.accessibilityGranted,
            blockers: UserDefaults.standard.stringArray(forKey: SetupNotifier.deliveredKey) ?? [],
            pendingCaptures: appState.pendingCaptures.count,
            recoveryStarted: appState.recoveryStarted,
            recoveryFinished: appState.backfillCompleted
        )
    }
}

/// Sends the report shortly after launch, then whenever it changes, and at least every 6 hours so
/// "last seen" stays meaningful -- checked every 15 minutes. Only when the Mac is connected to an
/// account; a failed send is simply tried again at the next check.
@MainActor
final class SetupReporter {
    private let appState: AppState
    private var timer: Timer?
    private let lastSentKey = "thread.setupReport.lastSent"
    private let lastSentAtKey = "thread.setupReport.lastSentAt"
    static let refreshEvery: TimeInterval = 6 * 3600

    init(appState: AppState) { self.appState = appState }

    func start() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in self?.check() }
        timer = Timer.scheduledTimer(withTimeInterval: 15 * 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.check() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    func check() {
        guard appState.isPaired else { return }
        let report = SetupReport.current(appState: appState)
        guard let encoded = try? JSONEncoder().encode(report) else { return }
        let defaults = UserDefaults.standard
        // "Minutes since the extension checked in" changes every minute; compare without it.
        var stable = report
        stable.extensionLastSeenMinutes = nil
        let signature = (try? JSONEncoder().encode(stable)).map { String(decoding: $0, as: UTF8.self) } ?? ""
        let lastAt = defaults.double(forKey: lastSentAtKey)
        let stale = Date().timeIntervalSince1970 - lastAt > Self.refreshEvery
        guard signature != defaults.string(forKey: lastSentKey) || stale else { return }
        let client = appState.client
        Task {
            do {
                try await client.sendSetupReport(encoded)
                defaults.set(signature, forKey: lastSentKey)
                defaults.set(Date().timeIntervalSince1970, forKey: lastSentAtKey)
            } catch {
                print("[ThreadMac] setup report not sent: \(error)")
            }
        }
    }
}
