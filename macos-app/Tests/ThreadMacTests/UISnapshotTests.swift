import SwiftUI
import XCTest
@testable import ThreadMac

/// Renders screens to PNG so they can be looked at without launching the app. Opt in:
///
///     THREAD_SNAPSHOT_DIR=/tmp/ui swift test --filter UISnapshotTests
///
/// Skipped everywhere else (CI never writes images). Not an assertion about pixels -- a way to see.
@MainActor
final class UISnapshotTests: XCTestCase {
    private var dir: URL {
        get throws {
            guard let path = ProcessInfo.processInfo.environment["THREAD_SNAPSHOT_DIR"] else {
                throw XCTSkip("set THREAD_SNAPSHOT_DIR to write screen snapshots")
            }
            let url = URL(fileURLWithPath: path, isDirectory: true)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            return url
        }
    }

    /// One view on the standard window background, at 2x, light and dark. Drawn through a real
    /// (offscreen) window so native AppKit-backed controls -- checkboxes, buttons -- render as they do
    /// in the app; SwiftUI's ImageRenderer can't draw those.
    @discardableResult
    private func snap<V: View>(_ name: String, width: CGFloat, height: CGFloat? = nil, @ViewBuilder _ content: () -> V) throws -> [URL] {
        var written: [URL] = []
        for scheme in [ColorScheme.light, .dark] {
            let appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)!
            let framed = content()
                .padding(20)
                .frame(width: width, height: height)
                .background(Color(nsColor: .windowBackgroundColor))
                .environment(\.controlActiveState, .key) // as in the frontmost window: accent-colored defaults
            let host = NSHostingView(rootView: framed)
            let size = NSSize(width: width, height: height ?? host.fittingSize.height)
            // A real window, parked far off screen and made key, so controls draw as they do in the
            // frontmost window (accent-colored default buttons) without anything appearing on screen.
            let window = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: size.width, height: size.height), styleMask: [.titled], backing: .buffered, defer: false)
            window.appearance = appearance
            window.contentView = host
            window.orderFrontRegardless()
            window.makeKey()
            defer { window.orderOut(nil) }
            host.frame = NSRect(origin: .zero, size: size)
            host.layoutSubtreeIfNeeded()
            let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: rep)
            let png = rep.representation(using: .png, properties: [:])
            let url = try dir.appendingPathComponent("\(name)-\(scheme == .dark ? "dark" : "light").png")
            XCTAssertNotNil(png, "could not render \(name)")
            try png?.write(to: url)
            written.append(url)
        }
        return written
    }

    func testWelcomeReady() throws {
        try snap("welcome-ready", width: 360) { WelcomeView(forcedMode: .ready).environmentObject(AppState()) }
    }

    func testWelcomeSignedOut() throws {
        try snap("welcome-signed-out", width: 360) { WelcomeView(forcedMode: .signedOut).environmentObject(AppState()) }
    }

    func testWelcomeSettingUp() throws {
        try snap("welcome-setting-up", width: 360) { WelcomeView(forcedMode: .settingUp).environmentObject(AppState()) }
    }

    func testQuestionList() throws {
        let loops = [
            OpenLoop(id: "1", statement: "Do guest collaborators count toward the bill?", createdAt: "2026-10-20T10:00:00Z", resolved: true,
                     answeredBy: "Five free guests per account, then they are billed like members."),
            OpenLoop(id: "2", statement: "Should we offer a yearly discount?", createdAt: "2026-10-20T10:05:00Z", resolved: false),
            OpenLoop(id: "3", statement: "Is a SOC 2 report a must-have ahead of landing enterprise customer number one?", createdAt: "2026-10-20T10:09:00Z", resolved: true),
        ]
        try snap("question-list", width: 380) { QuestionList(loops: loops) { _ in } }
    }

    // MARK: the small screens -- the states a person can actually land in

    func testReconnectKnownEmail() throws {
        let state = AppState()
        state.reconnect = .init(knownEmail: "allan@example.com", cachedIdeaCount: 3, cachedTitles: ["Per-seat pricing", "Security review", "First hire"], mismatch: false)
        try snap("reconnect-known", width: 360) { ReconnectView().environmentObject(state) }
    }

    func testReconnectMismatch() throws {
        let state = AppState()
        state.reconnect = .init(knownEmail: nil, cachedIdeaCount: 12, cachedTitles: ["Per-seat pricing", "Security review"], mismatch: true)
        try snap("reconnect-mismatch", width: 360) { ReconnectView().environmentObject(state) }
    }

    func testEmailCodeForm() throws {
        let state = AppState()
        try snap("email-code-form", width: 320) {
            EmailCodeForm(title: "Sign in to your Thread account", sendCode: { _ in true }, verify: { _, _ in true }, prefillEmail: "allan@example.com")
                .environmentObject(state)
        }
    }

    func testPaywallBanner() throws {
        let state = AppState()
        state.account = try JSONDecoder().decode(AccountStatus.self, from: Data(#"{"plan":"free","status":"free","isPro":false,"isAdmin":false,"canCapture":false,"ideaCount":25,"ideaCap":25,"currentPeriodEnd":null,"email":"allan@example.com","billingEnabled":true}"#.utf8))
        try snap("paywall-banner", width: 420) { PaywallBanner().environmentObject(state) }
    }

    func testCaptureHealthBanner() throws {
        let state = AppState()
        state.captureHealth = CaptureHealth(healthy: false, unresolvedConversations: 0, sensors: [.init(sensor: "browser_extension", observations: 12, failed: 7, degraded: true)])
        try snap("capture-health-banner", width: 420) { CaptureHealthBanner().environmentObject(state) }
    }

    // MARK: Settings

    /// A state for rendering Settings. The browser is shown as connected: the disconnected state prints
    /// the pairing string, which is the account's real credential (read from the Keychain), and a
    /// snapshot must never contain that.
    private func settingsState(plan: String, email: String?) throws -> AppState {
        let state = AppState()
        state.account = try account(plan: plan, email: email)
        state.lastExtensionPing = Date()
        XCTAssertTrue(state.browserConnected, "the snapshot would show the pairing string")
        return state
    }

    private func account(plan: String, email: String?) throws -> AccountStatus {
        let pro = plan == "pro"
        let e = email.map { "\"\($0)\"" } ?? "null"
        return try JSONDecoder().decode(AccountStatus.self, from: Data(#"{"plan":"\#(plan)","status":"\#(pro ? "active" : "free")","isPro":\#(pro),"isAdmin":false,"canCapture":true,"ideaCount":18,"ideaCap":25,"currentPeriodEnd":null,"email":\#(e),"billingEnabled":true}"#.utf8))
    }

    func testSettingsSignedInFree() throws {
        let state = try settingsState(plan: "free", email: "allan@example.com")
        try snap("settings-signed-in", width: 520, height: 2100) { SettingsView(embedded: true).environmentObject(state) }
    }

    func testSettingsAnonymous() throws {
        let state = try settingsState(plan: "free", email: nil)
        try snap("settings-anonymous", width: 520, height: 900) { SettingsView(embedded: true).environmentObject(state) }
    }

    func testSettingsAsSheet() throws {
        let state = try settingsState(plan: "pro", email: "allan@example.com")
        try snap("settings-sheet", width: 460, height: 640) { SettingsView().environmentObject(state) }
    }

    // MARK: "Still unanswered": today's rows vs two ways of not repeating the idea's title

    private let ideaTitle = "A continuity layer for thinking should reconstruct the…"
    private let questions = [
        "How to distinguish between two statements made weeks apart that represent the same evolving idea versus coincidence?",
        "What is the minimum context a continuity layer must hand back for resuming thinking to feel seamless?",
        "What is a continuity layer for human thinking?",
        "What is the user's opinion on the mind-stream-continuity project?",
        "What is the NOMOS paper about?",
    ]

    private static func qrow(_ i: Int, _ text: String, meta: String) -> IdeaRow {
        IdeaRow(id: "loop:\(i)", title: text, snippet: nil, meta: meta, isLoop: true, ideaId: "idea_a", when: "")
    }

    func testStillUnansweredToday() throws {
        let state = AppState(); let ideaTitle = self.ideaTitle; let questions = self.questions
        try snap("unanswered-today", width: 420) {
            VStack(spacing: 0) {
                ForEach(Array(questions.enumerated()), id: \.offset) { i, q in
                    IdeaRowView(row: Self.qrow(i, q, meta: "\(ideaTitle) · Sep 1"), selected: i == 0)
                }
                IdeaRowView(row: Self.qrow(9, "Do guest collaborators count toward the bill?", meta: "Per-seat pricing · Sep 3"), selected: false)
            }.environmentObject(state)
        }
    }

    /// Minimal: the idea's name is shown once, on the first of a run of questions from that idea.
    func testStillUnansweredNameOnce() throws {
        let state = AppState(); let ideaTitle = self.ideaTitle; let questions = self.questions
        try snap("unanswered-name-once", width: 420) {
            VStack(spacing: 0) {
                ForEach(Array(questions.enumerated()), id: \.offset) { i, q in
                    IdeaRowView(row: Self.qrow(i, q, meta: i == 0 ? "\(ideaTitle) · Sep 1" : "Sep 1"), selected: i == 0)
                }
                IdeaRowView(row: Self.qrow(9, "Do guest collaborators count toward the bill?", meta: "Per-seat pricing · Sep 3"), selected: false)
            }.environmentObject(state)
        }
    }

    /// Grouped: one quiet heading per idea, with its questions beneath it.
    func testStillUnansweredGrouped() throws {
        let state = AppState(); let ideaTitle = self.ideaTitle; let questions = self.questions
        func heading(_ title: String, _ count: Int) -> some View {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.subheadline.weight(.medium)).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                if count > 1 { Text("\(count) questions").font(.footnote).foregroundStyle(.tertiary) }
            }
            .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 2)
        }
        try snap("unanswered-grouped", width: 420) {
            VStack(alignment: .leading, spacing: 0) {
                heading(ideaTitle, questions.count)
                ForEach(Array(questions.enumerated()), id: \.offset) { i, q in
                    IdeaRowView(row: Self.qrow(i, q, meta: "Sep 1"), selected: i == 0)
                }
                heading("Per-seat pricing", 1)
                IdeaRowView(row: Self.qrow(9, "Do guest collaborators count toward the bill?", meta: "Sep 3"), selected: false)
            }.environmentObject(state)
        }
    }
}

