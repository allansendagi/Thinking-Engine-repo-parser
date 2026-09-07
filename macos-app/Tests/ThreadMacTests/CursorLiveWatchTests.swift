import XCTest
@testable import ThreadMac

/// The pure diff core of the continuous Cursor watch: first run seeds without sending, and after
/// that only a conversation whose turn set has grown is queued.
final class CursorLiveWatchTests: XCTestCase {

    private func msg(_ id: String, _ role: String = "user", _ text: String = "hi") -> CursorBackfill.Message {
        CursorBackfill.Message(bubbleId: id, role: role, text: text, createdAt: "2026-09-07T00:00:00Z")
    }

    private func conv(_ id: String, _ bubbleIds: [String]) -> CursorBackfill.Conversation {
        CursorBackfill.Conversation(
            composerId: id, title: id, lastUpdatedAt: nil, model: "grok-4.6",
            messages: bubbleIds.enumerated().map { msg($1, $0.isMultiple(of: 2) ? "user" : "assistant") }
        )
    }

    func testFingerprintTracksTurnCountAndLastBubble() {
        XCTAssertEqual(CursorLiveWatch.fingerprint(conv("a", ["u1", "a1"])), "2:a1")
        XCTAssertEqual(CursorLiveWatch.fingerprint(conv("a", ["u1", "a1", "u2"])), "3:u2")
        XCTAssertEqual(CursorLiveWatch.fingerprint(conv("a", [])), "0:")
    }

    func testFirstRunSeedsEveryConversationAndSendsNothing() {
        let c1 = conv("c1", ["u1", "a1"])
        let c2 = conv("c2", ["u1"])

        let plan = CursorLiveWatch.plan(convs: [c1, c2], seen: [:], seeded: false)

        XCTAssertEqual(plan.toSend, [])
        XCTAssertEqual(plan.seed, ["cursor::c1": "2:a1", "cursor::c2": "1:u1"])
        XCTAssertEqual(plan.fingerprints, [:])
    }

    func testUnchangedConversationIsSkipped() {
        let c1 = conv("c1", ["u1", "a1"])
        let seen = ["cursor::c1": CursorLiveWatch.fingerprint(c1)]

        let plan = CursorLiveWatch.plan(convs: [c1], seen: seen, seeded: true)

        XCTAssertNil(plan.seed)
        XCTAssertEqual(plan.toSend, [])
        XCTAssertEqual(plan.fingerprints, [:])
    }

    func testGrownAndBrandNewConversationsAreQueuedWithTheirNewFingerprint() {
        let c1old = conv("c1", ["u1", "a1"])
        let c1new = conv("c1", ["u1", "a1", "u2"])      // one more turn
        let c2 = conv("c2", ["u1", "a1"])                // never seen
        let c3 = conv("c3", ["u1"])                      // unchanged since seed
        let seen = [
            "cursor::c1": CursorLiveWatch.fingerprint(c1old),
            "cursor::c3": CursorLiveWatch.fingerprint(c3),
        ]

        let plan = CursorLiveWatch.plan(convs: [c1new, c2, c3], seen: seen, seeded: true)

        XCTAssertNil(plan.seed)
        XCTAssertEqual(plan.toSend.map(\.id), ["cursor::c1", "cursor::c2"])
        XCTAssertEqual(plan.fingerprints, ["cursor::c1": "3:u2", "cursor::c2": "2:a1"])
    }

    func testSeedingIsForcedAgainWhenSeededButNothingIsKnownYet() {
        // The account-switch path resets `seeded` to false in the watch before calling plan();
        // plan() then treats the store as a fresh seed regardless of the (now empty) `seen`.
        let c1 = conv("c1", ["u1", "a1"])
        let plan = CursorLiveWatch.plan(convs: [c1], seen: [:], seeded: false)
        XCTAssertEqual(plan.seed, ["cursor::c1": "2:a1"])
        XCTAssertEqual(plan.toSend, [])
    }
}
