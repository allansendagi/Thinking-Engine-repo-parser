import XCTest
@testable import ThreadMac

final class ContinuationPacketTests: XCTestCase {

    func testDecodesWithTheNewSecondPersonFields() throws {
        let json = """
        {
          "idea": { "id": "i1", "title": "Computable Authority", "state": "contested" },
          "whereYouLeftOff": "Institutional authority should be machine-executable and independently verified.",
          "contested": true,
          "evolution": [],
          "evolutionUnverified": false,
          "decisions": [{ "statement": "Frame NOMOS as a protocol.", "decidedAt": "2026-08-20T00:00:00.000Z" }],
          "unresolvedQuestion": "Who performs the verification, and why trust them?",
          "suggestedNext": "Help me compare verification models.",
          "thinkingShift": "You moved from AI governance toward machine-executable institutional authority.",
          "lastExploredSource": "Claude",
          "lastExploredAt": "2026-08-15T00:00:00.000Z"
        }
        """.data(using: .utf8)!
        let p = try JSONDecoder().decode(ContinuationPacket.self, from: json)
        XCTAssertEqual(p.thinkingShift, "You moved from AI governance toward machine-executable institutional authority.")
        XCTAssertEqual(p.lastExploredSource, "Claude")
        XCTAssertEqual(p.decisions.first?.statement, "Frame NOMOS as a protocol.")
    }

    /// A response from the currently-deployed server, before these fields shipped, must still decode.
    func testDecodesWithoutTheNewFields() throws {
        let json = """
        {
          "idea": { "id": "i1", "title": "T", "state": "developing" },
          "whereYouLeftOff": "here",
          "contested": false,
          "evolution": [],
          "evolutionUnverified": false,
          "decisions": [],
          "unresolvedQuestion": null,
          "suggestedNext": "next"
        }
        """.data(using: .utf8)!
        let p = try JSONDecoder().decode(ContinuationPacket.self, from: json)
        XCTAssertNil(p.thinkingShift)
        XCTAssertNil(p.lastExploredSource)
        XCTAssertNil(p.lastExploredAt)
    }

    @MainActor
    func testCopyTextSubstitutesBothTokens() {
        let state = AppState()
        state.continuationText = "How your thinking changed\n\(ContinuationPacket.thinkingShiftToken)\n\nContinue from here\n\(ContinuationPacket.continueToken)\n"
        state.continuationPacket = ContinuationPacket(
            idea: .init(id: "i", title: "T", state: "developing"),
            whereYouLeftOff: "x", contested: false, evolution: [], evolutionUnverified: false,
            decisions: [], unresolvedQuestion: nil, suggestedNext: "the templated next step",
            thinkingShift: "You moved from A toward B.", lastExploredSource: nil, lastExploredAt: nil
        )
        state.nextStepDraft = ""
        let out = state.continuationCopyText ?? ""
        XCTAssertTrue(out.contains("You moved from A toward B."))
        XCTAssertTrue(out.contains("the templated next step"))
        XCTAssertFalse(out.contains("{{"))
    }
}
