import XCTest
@testable import ThreadMac

/// The pure parsing of Cursor's `cursorDiskKV` store -- typed roles from the conversation
/// headers, text turns from the bubbles, agent machinery (thinking / tool calls) dropped.
/// Fixture shapes mirror a real `state.vscdb` dump (2026-09-07).
final class CursorBackfillTests: XCTestCase {

    func testRoleComesFromTheHeaderType() {
        XCTAssertEqual(CursorBackfill.roleFor(type: 1), "user")
        XCTAssertEqual(CursorBackfill.roleFor(type: 2), "assistant")
        XCTAssertEqual(CursorBackfill.roleFor(type: NSNumber(value: 2)), "assistant")
        XCTAssertNil(CursorBackfill.roleFor(type: 0))
        XCTAssertNil(CursorBackfill.roleFor(type: 3))
        XCTAssertNil(CursorBackfill.roleFor(type: nil))
        XCTAssertNil(CursorBackfill.roleFor(type: "user"))
    }

    func testMessageTextIsTheTurnOrNilForMachinery() {
        XCTAssertEqual(CursorBackfill.messageText(from: ["text": "  does cursor work  "]), "does cursor work")
        XCTAssertNil(CursorBackfill.messageText(from: ["text": ""]))
        XCTAssertNil(CursorBackfill.messageText(from: ["text": "   \n "]))
        XCTAssertNil(CursorBackfill.messageText(from: ["toolFormerData": ["x": 1]]))          // tool call
        XCTAssertNil(CursorBackfill.messageText(from: ["capabilityType": 30, "text": ""]))    // thinking block
        XCTAssertNil(CursorBackfill.messageText(from: [:]))
    }

    // MARK: parseConversation

    private func header(_ bid: String, _ type: Int, _ at: String) -> [String: Any] {
        ["bubbleId": bid, "type": type, "createdAt": at]
    }

    func testBuildsAnOrderedRoledConversationAndDropsMachinery() {
        let cd: [String: Any] = [
            "name": "Cursor functionality inquiry",
            "lastUpdatedAt": 1_788_785_546_052,
            "modelConfig": ["modelName": "grok-4.6"],
            "fullConversationHeadersOnly": [
                header("u1", 1, "2026-09-07T12:51:31.729Z"),
                header("think1", 2, "2026-09-07T12:51:38.259Z"),
                header("a1", 2, "2026-09-07T12:51:39.000Z"),
                header("tool1", 2, "2026-09-07T12:51:39.500Z"),
                header("u2", 1, "2026-09-07T12:52:26.000Z"),
                header("a2", 2, "2026-09-07T12:52:31.000Z"),
            ],
        ]
        let bubbles: [String: [String: Any]] = [
            "u1": ["type": 1, "text": "does cursor work"],
            "think1": ["type": 2, "capabilityType": 30, "text": ""],
            "a1": ["type": 2, "text": "I'll check Cursor's status."],
            "tool1": ["type": 2, "toolFormerData": ["name": "search"], "text": ""],
            "u2": ["type": 1, "text": "what do you know about computable authority"],
            "a2": ["type": 2, "text": "It's the discipline of turning institutional authority into something machine-executable."],
        ]

        let c = CursorBackfill.parseConversation(composerId: "abc", composerData: cd, bubble: { bubbles[$0] })
        XCTAssertNotNil(c)
        XCTAssertEqual(c?.id, "cursor::abc")
        XCTAssertEqual(c?.title, "Cursor functionality inquiry")
        XCTAssertEqual(c?.model, "grok-4.6")
        XCTAssertEqual(c?.messages.map(\.role), ["user", "assistant", "user", "assistant"])
        XCTAssertEqual(c?.messages.map(\.bubbleId), ["u1", "a1", "u2", "a2"])
        XCTAssertEqual(c?.messages.first?.text, "does cursor work")
        XCTAssertEqual(c?.messages.first?.createdAt, "2026-09-07T12:51:31.729Z")
        XCTAssertEqual(c?.lastUpdatedAt, Date(timeIntervalSince1970: 1_788_785_546.052))
    }

    func testDraftAndEmptyAndAllMachineryReturnNil() {
        let headers = [header("t", 2, "2026-09-07T00:00:00Z")]

        // a draft
        XCTAssertNil(CursorBackfill.parseConversation(
            composerId: "d", composerData: ["isDraft": true, "fullConversationHeadersOnly": headers],
            bubble: { _ in ["type": 2, "text": "ignored"] }))

        // no headers
        XCTAssertNil(CursorBackfill.parseConversation(
            composerId: "e", composerData: ["name": "x"], bubble: { _ in nil }))

        // headers present but every bubble is machinery -> no text turns
        XCTAssertNil(CursorBackfill.parseConversation(
            composerId: "m", composerData: ["fullConversationHeadersOnly": headers],
            bubble: { _ in ["type": 2, "toolFormerData": [:], "text": ""] }))
    }

    func testStateDbPathHonorsTheEnvOverride() {
        XCTAssertTrue(CursorBackfill.stateDbPath.hasSuffix("globalStorage/state.vscdb")
                      || CursorBackfill.stateDbPath == ProcessInfo.processInfo.environment["THREAD_CURSOR_STATE_DB_PATH"])
    }
}
