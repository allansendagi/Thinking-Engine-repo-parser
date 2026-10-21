import AppKit
import SwiftUI
import XCTest
@testable import ThreadMac

/// Renders every main screen with sample ideas, in the Mac's light or dark appearance, for a
/// visual check and a before/after pixel diff (light mode must not change). Writes PNGs only when
/// THREAD_RENDER_DIR is set (THREAD_APPEARANCE=dark for dark; light otherwise). Never touches the
/// network or the real account: the credential lives in a temp directory.
final class AppearanceTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        guard ProcessInfo.processInfo.environment["THREAD_RENDER_DIR"] != nil else { throw XCTSkip("set THREAD_RENDER_DIR to render") }
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("appearance-\(UUID().uuidString)")
        CredentialStore.directoryOverride = dir
        LocalStore.directoryOverride = dir
        CredentialStore.save(userId: "user_sample", token: "sample")
        CredentialStore.apiBaseUrl = "http://127.0.0.1:9"
        UserDefaults.standard.set(true, forKey: "thread.lesson.introSeen")
    }

    override func tearDown() {
        CredentialStore.apiBaseUrl = CredentialStore.defaultApiBaseUrl
        CredentialStore.directoryOverride = nil
        LocalStore.directoryOverride = nil
        MainActor.assumeIsolated { DisclosureDefaults.startOpen = [] }
        if let dir { try? FileManager.default.removeItem(at: dir) }
    }

    private static func iso(_ ago: TimeInterval) -> String { ISO8601DateFormatter().string(from: Date().addingTimeInterval(-ago)) }
    private static let h: TimeInterval = 3600, d: TimeInterval = 86_400

    private static let ideas: [(id: String, title: String, f: String, src: String, ago: TimeInterval)] = [
        ("i1", "Authority should be checkable by a machine", "Authority only counts if software can check an action against the rule before it happens.", "claude", 24 * 60),
        ("i2", "Every decision carries its authority", "A decision isn't done until it records who allowed it, under which rule, and when.", "chatgpt", 2 * h),
        ("i3", "Rules drift unless they're versioned like code", "A rule that can change silently isn't authority. Version it, sign it, and keep the old ones.", "cursor", 5 * h),
        ("i4", "Delegation should only ever narrow", "Authority handed down can shrink but never grow.", "claude", d + 3 * h),
        ("i5", "The audit trail is the product", "The record of why something was allowed is worth more than the permission itself.", "gemini", d + 6 * h),
    ]

    private static func state() throws -> ThinkingStateResponse {
        let current = ideas.map { ["id": $0.id, "title": $0.title, "state": "developing", "currentFormulation": $0.f, "latestSource": $0.src] }
        let changes = ideas.map { ["ideaId": $0.id, "ideaTitle": $0.title, "formulation": $0.f, "createdAt": iso($0.ago)] }
        let loop: [String: Any] = ["ideaId": "i1", "ideaTitle": ideas[0].title, "loopId": "l1", "statement": "Who is allowed to change the rule itself?", "resolved": false, "createdAt": iso(20 * d), "latestSource": "chatgpt"]
        let json: [String: Any] = [
            "topic": NSNull(), "currentIdeas": current, "recentChanges": changes, "decisions": [],
            "openLoops": [loop], "contradictions": [], "relatedIdeas": [],
            "revisit": [["ideaId": "i1", "ideaTitle": ideas[0].title, "loopId": "l1", "statement": "Who is allowed to change the rule itself?", "raisedAt": iso(20 * d), "backOnTopicAt": iso(24 * 60), "via": NSNull()]],
        ]
        return try JSONDecoder().decode(ThinkingStateResponse.self, from: JSONSerialization.data(withJSONObject: json))
    }

    private static func trace() throws -> IdeaTrace {
        let steps: [(String, String, TimeInterval)] = [
            ("Policies are documents people interpret.", "chatgpt", 20 * d),
            ("Policies could be code, but code alone doesn't say who gave it authority.", "cursor", 12 * d),
            (ideas[0].f, "claude", 24 * 60),
        ]
        let evolution = steps.map { ["formulation": $0.0, "createdAt": iso($0.2)] }
        let provenance = steps.map { ["formulation": $0.0, "createdAt": iso($0.2), "sourceText": "sample", "sourceRole": "user", "source": $0.1, "sourceUrl": NSNull(), "conversationId": "c_\($0.1)"] as [String: Any] }
        let json: [String: Any] = [
            "idea": ["id": "i1", "title": ideas[0].title, "state": "developing", "currentFormulation": ideas[0].f, "evolution": evolution,
                     "openLoops": [["id": "l1", "statement": "Who is allowed to change the rule itself?", "createdAt": iso(20 * d), "resolved": false]],
                     "decisions": [["id": "dc1", "statement": "Write every page for this person first.", "decidedAt": iso(24 * 60)]],
                     "relatedIdeaIds": ["i2", "i3"], "createdAt": iso(20 * d), "updatedAt": iso(24 * 60)],
            "provenance": provenance,
        ]
        return try JSONDecoder().decode(IdeaTrace.self, from: JSONSerialization.data(withJSONObject: json))
    }

    private static let lessonJSON = """
    {"questions":[
      {"kind":"idea","reason":"unsure","ideaId":"i7","title":"Name the free tier after what it gives","statement":"Call it by what it gives you, not by what's missing.","source":"chatgpt","lastTouched":"\(iso(6 * h))"},
      {"kind":"pair","a":{"ideaId":"i2","title":"Every decision carries its authority","statement":"A decision isn't done until it records who allowed it.","source":"chatgpt","lastTouched":"\(iso(2 * h))"},
                     "b":{"ideaId":"i5","title":"The audit trail is the product","statement":"The record of why something was allowed matters most.","source":"gemini","lastTouched":"\(iso(d))"}}
    ],"learned":42,"acceptanceRate":0.82,"acceptanceSample":28,"ready":true}
    """

    private var dark: Bool { ProcessInfo.processInfo.environment["THREAD_APPEARANCE"] == "dark" }

    /// A fresh app state with the sample thinking, then `configure`.
    @MainActor private func sample(_ configure: (AppState) throws -> Void = { _ in }) throws -> AppState {
        let s = AppState()
        s.thinkingState = try Self.state()
        s.lastSyncedAt = Date()
        try configure(s)
        return s
    }

    @MainActor private func render<V: View>(_ name: String, width: CGFloat, height: CGFloat, state: AppState? = nil, @ViewBuilder _ view: () -> V) throws {
        let out = URL(fileURLWithPath: ProcessInfo.processInfo.environment["THREAD_RENDER_DIR"]!)
        let appState = state ?? AppState()
        let host = NSHostingView(rootView: view().environmentObject(appState))
        host.frame = NSRect(x: 0, y: 0, width: width, height: height)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.8))
        appState.isOffline = false
        appState.errorMessage = nil
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        host.layoutSubtreeIfNeeded()
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(width * 2), pixelsHigh: Int(height * 2), bitsPerSample: 8, samplesPerPixel: 4,
                                   hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        rep.size = host.bounds.size
        host.cacheDisplay(in: host.bounds, to: rep)
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: out.appendingPathComponent("\(name).png"))
    }

    @MainActor
    func testRenderEveryScreen() throws {
        let w = Theme.panelWidth, h = Theme.panelHeight

        // The panel: Recent (with the lesson invitation), Open questions, All -> Ideas.
        let lesson = try JSONDecoder().decode(Lesson.self, from: Data(Self.lessonJSON.utf8))
        let recent = try sample { $0.lesson = lesson }
        try render("panel-recent", width: w, height: h, state: recent) { RootView() }
        let loops = try sample { $0.listTab = .loops }
        try render("panel-loops", width: w, height: h, state: loops) { RootView() }
        let all = try sample { $0.listTab = .all; $0.allMode = .ideas }
        try render("panel-all", width: w, height: h, state: all) { RootView() }

        // One idea, collapsed and with its history open.
        let idea = try sample { $0.selectedIdeaId = "i1"; $0.selectedTrace = try Self.trace() }
        try render("idea-collapsed", width: w, height: h, state: idea) { RootView() }
        DisclosureDefaults.startOpen = ["How your thinking changed", "Sources"]
        let open = try sample { $0.selectedIdeaId = "i1"; $0.selectedTrace = try Self.trace() }
        try render("idea-open", width: w, height: h, state: open) { RootView() }
        DisclosureDefaults.startOpen = []

        // Teach Thread: a single question, then a pair.
        let teach = try sample { $0.lesson = lesson; $0.lessonQuestions = lesson.questions; $0.lessonIndex = 0; $0.lessonOpen = true }
        try render("teach-idea", width: w, height: h, state: teach) { RootView() }
        let pair = try sample { $0.lesson = lesson; $0.lessonQuestions = lesson.questions; $0.lessonIndex = 1; $0.lessonOpen = true }
        try render("teach-pair", width: w, height: h, state: pair) { RootView() }

        // First run: no ideas yet, so the welcome shows. A fresh store, so the snapshots the screens
        // above saved don't leak into it.
        LocalStore.directoryOverride = dir.appendingPathComponent("first-run")
        let welcome = AppState()
        welcome.lastSyncedAt = Date()
        try render("welcome", width: w, height: h, state: welcome) { RootView() }

        // The full window and settings.
        let main = try sample { $0.selectedIdeaId = "i1"; $0.selectedTrace = try Self.trace() }
        try render("window", width: 1180, height: 760, state: main) { MainWindowView() }
        try render("settings", width: 520, height: 640, state: try sample()) { SettingsView() }
        try render("paste", width: 460, height: 420, state: try sample()) { PasteView() }
    }
}
