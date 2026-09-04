import XCTest
@testable import ThreadMac

final class BackfillTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("thread-backfill-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func write(_ name: String, _ contents: String) -> URL {
        let u = dir.appendingPathComponent(name)
        try? contents.write(to: u, atomically: true, encoding: .utf8)
        return u
    }

    func testDetectsAChatGptExportJson() {
        let u = write("conversations.json", """
        [{"id":"c1","current_node":"n1","mapping":{"n1":{"id":"n1","parent":null,"children":[],
          "message":{"id":"n1","author":{"role":"user"},"content":{"content_type":"text","parts":["hi"]},"create_time":1}}}}]
        """)
        let d = Backfill.inspect(u)
        XCTAssertEqual(d?.kind, .chatgpt)
        XCTAssertEqual(d?.conversationCount, 1)
    }

    func testDetectsAClaudeExportJson() {
        let u = write("conversations.json", #"[{"uuid":"c1","name":"x","chat_messages":[{"uuid":"m1","sender":"human","text":"hi"}]}]"#)
        let d = Backfill.inspect(u)
        XCTAssertEqual(d?.kind, .claude)
    }

    func testRejectsNonExportJson() {
        XCTAssertNil(Backfill.inspect(write("data.json", #"{"hello":"world"}"#)))
        XCTAssertNil(Backfill.inspect(write("list.json", #"[1,2,3]"#)))
        XCTAssertNil(Backfill.inspect(write("notes.txt", "just some notes")))
    }

    func testExportPageUrlsAreProviderSettings() {
        XCTAssertEqual(BackfillKind.chatgpt.exportPageURL.host, "chatgpt.com")
        XCTAssertEqual(BackfillKind.claude.exportPageURL.host, "claude.ai")
        XCTAssertEqual(BackfillKind.chatgpt.apiFormat, "chatgpt")
        XCTAssertEqual(BackfillKind.claude.apiFormat, "claude")
    }
}
