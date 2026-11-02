import XCTest
@testable import ThreadMac

final class SetupReportTests: XCTestCase {
    private func report(
        ping: Date? = nil, defaultBrowser: String? = "com.apple.Safari", installed: Set<String> = [],
        cursor: Bool = false, local: [String] = [], blockers: [String] = []
    ) -> SetupReport {
        SetupReport.make(
            lastExtensionPing: ping, now: Date(timeIntervalSince1970: 10_000), defaultBrowserID: defaultBrowser,
            installed: { installed.contains($0) }, cursorHistoryFound: cursor, localSourcesFound: local,
            accessibilityGranted: false, blockers: blockers, pendingCaptures: 0
        )
    }

    func testNamesComeFromFixedListsOnly() {
        let r = report(defaultBrowser: "com.example.SomeBrowser",
                       installed: ["com.google.Chrome", "com.apple.Safari", "com.openai.codex", "com.anthropic.claudefordesktop"])
        XCTAssertEqual(r.defaultBrowser, "other")              // an unknown browser is never named
        XCTAssertEqual(r.extensionBrowsersInstalled, ["chrome"]) // Safari can't run the extension
        XCTAssertEqual(r.aiAppsInstalled, ["chatgpt", "claude"]) // either ChatGPT id counts
    }

    func testExtensionLastSeenIsMinutesAndAbsentWhenNeverConnected() {
        XCTAssertFalse(report().extensionEverConnected)
        XCTAssertNil(report().extensionLastSeenMinutes)
        let seen = report(ping: Date(timeIntervalSince1970: 10_000 - 600))
        XCTAssertTrue(seen.extensionEverConnected)
        XCTAssertEqual(seen.extensionLastSeenMinutes, 10)
    }

    func testEncodesNoContentAndStableOrder() throws {
        let r = report(cursor: true, local: ["codex", "claude_code"], blockers: ["notPaired", "accessibility"])
        XCTAssertEqual(r.localSourcesFound, ["claude_code", "codex"])
        XCTAssertEqual(r.blockers, ["accessibility", "notPaired"])
        let json = String(decoding: try JSONEncoder().encode(r), as: UTF8.self)
        XCTAssertFalse(json.contains("/Users/"))
        XCTAssertTrue(json.contains("\"cursorHistoryFound\":true"))
        XCTAssertTrue(json.contains("\"recoveryStarted\":false"))
    }
}
