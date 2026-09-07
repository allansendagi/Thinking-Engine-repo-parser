import XCTest
@testable import ThreadMac

/// `AITool.from` decides where "Continue" routes. Provenance carries a display label ("ChatGPT"),
/// backfill a slug ("chatgpt"), some rows a host or bundle id -- before the tolerant match every
/// non-slug value fell through to `.claude`, which is the "always routes to Claude" bug.
final class AIToolRoutingTests: XCTestCase {
    func testMatchesTheDisplayLabelProvenanceActuallyCarries() {
        XCTAssertEqual(AppState.AITool.from(source: "ChatGPT"), .chatgpt)
        XCTAssertEqual(AppState.AITool.from(source: "Claude"), .claude)
        XCTAssertEqual(AppState.AITool.from(source: "Gemini"), .gemini)
        XCTAssertEqual(AppState.AITool.from(source: "Cursor"), .cursor)
    }

    func testMatchesSlugsHostsAndBundleIds() {
        XCTAssertEqual(AppState.AITool.from(source: "chatgpt"), .chatgpt)
        XCTAssertEqual(AppState.AITool.from(source: "chatgpt.com"), .chatgpt)
        XCTAssertEqual(AppState.AITool.from(source: "com.openai.codex"), .chatgpt)
        XCTAssertEqual(AppState.AITool.from(source: "claude.ai"), .claude)
        XCTAssertEqual(AppState.AITool.from(source: "com.anthropic.claudefordesktop"), .claude)
        XCTAssertEqual(AppState.AITool.from(source: "gemini.google.com"), .gemini)
    }

    func testUnknownOrEmptyIsNil() {
        XCTAssertNil(AppState.AITool.from(source: nil))
        XCTAssertNil(AppState.AITool.from(source: ""))
        XCTAssertNil(AppState.AITool.from(source: "Pasted"))
        XCTAssertNil(AppState.AITool.from(source: "some-random-tool"))
    }
}
