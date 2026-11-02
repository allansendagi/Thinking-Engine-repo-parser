import AppKit
import SwiftUI
import XCTest
@testable import ThreadMac

/// Renders the real panel (RootView) with a sample account for the website's product shot.
/// Written only when THREAD_RENDER_DIR is set; never reaches the network or the real account.
final class SiteShotsTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        guard ProcessInfo.processInfo.environment["THREAD_RENDER_DIR"] != nil else { throw XCTSkip("set THREAD_RENDER_DIR to render") }
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("siteshots-\(UUID().uuidString)")
        CredentialStore.directoryOverride = dir
        LocalStore.directoryOverride = dir
        CredentialStore.save(userId: "user_sample", token: "sample")
        CredentialStore.apiBaseUrl = "http://127.0.0.1:9"
    }

    override func tearDown() {
        CredentialStore.apiBaseUrl = CredentialStore.defaultApiBaseUrl
        CredentialStore.directoryOverride = nil
        LocalStore.directoryOverride = nil
        if let dir { try? FileManager.default.removeItem(at: dir) }
    }

    private static func iso(_ ago: TimeInterval) -> String { ISO8601DateFormatter().string(from: Date().addingTimeInterval(-ago)) }
    private static let h: TimeInterval = 3600, d: TimeInterval = 86_400

    private static let ideas: [(id: String, title: String, f: String, src: String, ago: TimeInterval)] = [
        ("i1", "The customer is people who think out loud with AI", "Not \u{201C}AI users\u{201D} \u{2014} people who think out loud with AI and keep losing the thread.", "claude", 24 * 60),
        ("i2", "Price on outcomes, not seats", "Charge for the thinking Thread keeps, not for the people using it.", "chatgpt", 2 * h),
        ("i3", "Onboarding ends at the first idea", "Skip the tour: the first thing a new user sees should be an idea of their own.", "cursor", 5 * h),
        ("i4", "Launch to fifty people who already feel the pain", "A small launch to people who lose ideas every week beats a big one to everyone.", "claude", d + 3 * h),
        ("i5", "Write the manifesto before the landing page", "If the belief isn't clear in a page of prose, no hero section will fix it.", "gemini", d + 6 * h),
    ]

    @MainActor
    func testRenderRecent() throws {
        let out = URL(fileURLWithPath: ProcessInfo.processInfo.environment["THREAD_RENDER_DIR"]!)
        let current = Self.ideas.map { ["id": $0.id, "title": $0.title, "state": "developing", "currentFormulation": $0.f, "latestSource": $0.src] }
        let changes = Self.ideas.map { ["ideaId": $0.id, "ideaTitle": $0.title, "formulation": $0.f, "createdAt": Self.iso($0.ago)] }
        let json: [String: Any] = [
            "topic": NSNull(), "currentIdeas": current, "recentChanges": changes, "decisions": [],
            "openLoops": [], "contradictions": [], "relatedIdeas": [],
            "revisit": [["ideaId": "i1", "ideaTitle": Self.ideas[0].title, "loopId": "l1",
                         "statement": "Is a niche this sharp big enough to build a company on?",
                         "raisedAt": Self.iso(20 * Self.d), "backOnTopicAt": Self.iso(24 * 60), "via": NSNull()]],
        ]
        let s = AppState()
        s.thinkingState = try JSONDecoder().decode(ThinkingStateResponse.self, from: JSONSerialization.data(withJSONObject: json))
        s.lastSyncedAt = Date()
        let host = NSHostingView(rootView: RootView().environmentObject(s))
        host.frame = NSRect(x: 0, y: 0, width: Theme.panelWidth, height: Theme.panelHeight)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.8))
        s.isOffline = false
        s.errorMessage = nil
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        host.layoutSubtreeIfNeeded()
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(host.bounds.width * 2), pixelsHigh: Int(host.bounds.height * 2),
                                   bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        rep.size = host.bounds.size
        host.cacheDisplay(in: host.bounds, to: rep)
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: out.appendingPathComponent("recent.png"))
    }

    /// Renders one view to `<name>-<light|dark>.png` in THREAD_RENDER_DIR, on the window background,
    /// for checking new first-run screens by eye.
    @MainActor
    private func render<V: View>(_ view: V, _ name: String, width: CGFloat, afterAppear: (() -> Void)? = nil) throws {
        let out = URL(fileURLWithPath: ProcessInfo.processInfo.environment["THREAD_RENDER_DIR"]!)
        for (suffix, appearance) in [("light", NSAppearance(named: .aqua)!), ("dark", NSAppearance(named: .darkAqua)!)] {
            let host = NSHostingView(rootView: view.background(Color(nsColor: .windowBackgroundColor)))
            host.appearance = appearance
            host.frame = NSRect(x: 0, y: 0, width: width, height: 10)
            host.frame.size = host.fittingSize
            let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
            window.appearance = appearance
            window.contentView = host
            RunLoop.main.run(until: Date().addingTimeInterval(0.3))
            if let afterAppear {
                afterAppear()
                RunLoop.main.run(until: Date().addingTimeInterval(0.3))
                host.frame.size = host.fittingSize
            }
            host.layoutSubtreeIfNeeded()
            let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: rep)
            try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: out.appendingPathComponent("\(name)-\(suffix).png"))
        }
    }

    @MainActor
    func testRenderRecoveryEmailStep() throws {
        let s = AppState()
        s.backfill = .needsEmail(.cursor)
        try render(BackfillView().environmentObject(s), "recovery-email", width: 400)
        try render(BackfillView().environmentObject(s), "recovery-email-taken", width: 400) {
            s.claimEmailInUse = "taken@example.com"
            s.authError = "That email is already on your other Thread account — sign in to it instead."
        }
    }

    @MainActor
    func testRenderWelcome() throws {
        let s = AppState()
        try render(WelcomeView(forcedMode: .ready).environmentObject(s), "welcome", width: 320)
    }
}
