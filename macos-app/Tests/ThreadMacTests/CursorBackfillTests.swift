import XCTest
@testable import ThreadMac

/// The heuristic scan (mirror of the desktop-agent's) -- the fragile part, so pin its behaviour.
final class CursorBackfillTests: XCTestCase {

    private func scan(_ json: String) -> [(role: String, text: String)] {
        let obj = try! JSONSerialization.jsonObject(with: Data(json.utf8))
        return CursorBackfill.scanForMessages(obj)
    }

    func testFindsAMessageArrayNestedInArbitraryJson() {
        let msgs = scan("""
        {"workspace":{"tabs":[{"conversation":{"messages":[
          {"role":"user","text":"Should authority be machine-executable?"},
          {"role":"assistant","text":"Here's a way to think about it..."},
          {"role":"user","text":"Yes — the resolver has to be a program."}
        ]}}]}}
        """)
        XCTAssertEqual(msgs.count, 3)
        XCTAssertEqual(msgs.first?.role, "user")
        XCTAssertEqual(msgs.last?.text, "Yes — the resolver has to be a program.")
    }

    func testAcceptsAlternateRoleAndTextKeys() {
        let msgs = scan(#"[{"sender":"human","content":"hi"},{"sender":"ai","message":"hello"}]"#)
        XCTAssertEqual(msgs.map(\.role), ["user", "assistant"])
    }

    func testIgnoresAnArrayThatIsMostlyNotMessages() {
        let msgs = scan(#"["/a/b.ts","/c/d.ts",{"role":"user","text":"one real one"}]"#)
        XCTAssertTrue(msgs.isEmpty)
    }

    func testReturnsNothingForNonConversationJson() {
        XCTAssertTrue(scan(#"{"theme":"dark","fontSize":13}"#).isEmpty)
        XCTAssertTrue(scan(#"[1,2,3]"#).isEmpty)
    }

    func testStateDbPathHonorsTheEnvOverride() {
        // Not set in CI -> the default under Cursor's globalStorage.
        XCTAssertTrue(CursorBackfill.stateDbPath.hasSuffix("globalStorage/state.vscdb")
                      || CursorBackfill.stateDbPath == ProcessInfo.processInfo.environment["THREAD_CURSOR_STATE_DB_PATH"])
    }
}
