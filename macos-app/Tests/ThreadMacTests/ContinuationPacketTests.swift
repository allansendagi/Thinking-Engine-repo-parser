import XCTest
@testable import ThreadMac

final class ContinuationPacketTests: XCTestCase {

    func testDecodesTheFullMachineHandoffPacket() throws {
        let json = """
        {
          "idea": { "id": "i1", "title": "Computable Authority", "state": "contested" },
          "whereYouLeftOff": "Institutional authority should be machine-executable and independently verified.",
          "contested": true,
          "evolution": [],
          "evolutionUnverified": false,
          "decisions": [{ "statement": "Frame NOMOS as a protocol.", "decidedAt": "2026-08-20T00:00:00.000Z" }],
          "unresolvedQuestion": "Who performs the verification, and why trust them?",
          "unresolvedQuestions": ["Who performs verification?", "Why trust that verifier?"],
          "suggestedNext": "Help me compare verification models.",
          "trajectory": ["AI governance", "policy/execution gap", "authority must be executable"],
          "thinkingShift": "You moved from AI governance toward machine-executable institutional authority.",
          "lastExploredSource": "Claude",
          "lastExploredAt": "2026-08-15T00:00:00.000Z"
        }
        """.data(using: .utf8)!
        let p = try JSONDecoder().decode(ContinuationPacket.self, from: json)
        XCTAssertEqual(p.trajectory, ["AI governance", "policy/execution gap", "authority must be executable"])
        XCTAssertEqual(p.unresolvedQuestions, ["Who performs verification?", "Why trust that verifier?"])
        XCTAssertEqual(p.thinkingShift, "You moved from AI governance toward machine-executable institutional authority.")
        XCTAssertEqual(p.lastExploredSource, "Claude")
        XCTAssertEqual(
            p.trajectoryChain,
            "AI governance\n  ↓\n  policy/execution gap\n  ↓\n  authority must be executable"
        )
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
        XCTAssertNil(p.trajectory)
        XCTAssertNil(p.unresolvedQuestions)
        XCTAssertNil(p.lastExploredSource)
        XCTAssertEqual(p.trajectoryChain, "")
    }

    @MainActor
    func testCopyTextFillsEveryToken() {
        let state = AppState()
        state.continuationText = """
        THINKING EVOLUTION
          \(ContinuationPacket.thinkingEvolutionToken)

        TASK
        Continue the reasoning from this exact state. Do not restart the exploration.

        \(ContinuationPacket.continueToken)
        """
        state.continuationPacket = ContinuationPacket(
            idea: .init(id: "i", title: "T", state: "developing"),
            whereYouLeftOff: "x", contested: false, evolution: [], evolutionUnverified: false,
            decisions: [], unresolvedQuestion: nil, unresolvedQuestions: nil,
            suggestedNext: "the templated next step",
            trajectory: ["AI governance", "policy/execution gap", "authority must be executable"],
            thinkingShift: nil, lastExploredSource: nil, lastExploredAt: nil
        )
        state.nextStepDraft = ""
        let out = state.continuationCopyText ?? ""
        XCTAssertTrue(out.contains("AI governance\n  ↓\n  policy/execution gap\n  ↓\n  authority must be executable"))
        XCTAssertTrue(out.contains("the templated next step"))
        XCTAssertTrue(out.contains("Do not restart the exploration."))
        XCTAssertFalse(out.contains("{{"))
    }
}
