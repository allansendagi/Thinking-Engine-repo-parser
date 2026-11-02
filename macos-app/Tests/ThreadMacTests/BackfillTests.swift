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

    // MARK: - resume (startingAt)

    private func claudeExport(_ n: Int) -> URL {
        let objs = (0..<n).map { i in
            "{\"uuid\":\"c\(i)\",\"name\":\"x\",\"chat_messages\":[{\"uuid\":\"m\(i)\",\"sender\":\"human\",\"text\":\"hi \(i)\"}]}"
        }
        return write("conversations.json", "[\(objs.joined(separator: ","))]")
    }

    func testRunResumesFromStartingAtAndSkipsEarlierBatches() async throws {
        MockURLProtocol.reset()
        MockURLProtocol.stubs["POST /v1/import"] = .init(
            status: 200,
            body: Data(#"{"newCanonicalEvents":0,"newCognitiveEvents":0,"rejectedExtractions":0,"ideaCount":9}"#.utf8)
        )
        let export = DetectedExport(url: claudeExport(40), kind: .claude, conversationCount: 40, modified: Date())
        let client = APIClient(baseURL: "http://x", credentials: ("u", "t"), session: MockURLProtocol.makeSession())

        var last: BackfillProgress?
        let (summary, capped) = try await Backfill.run(
            export, ids: (0..<40).map { "c\($0)" }, client: client, progress: { last = $0 }, startingAt: 15
        )

        // A resume uses full batches of 15: starting at 15 leaves [15..<30] and [30..<40] -- two
        // requests, not four.
        let importCalls = MockURLProtocol.capturedRequests.filter { $0.url?.path == "/v1/import" }
        XCTAssertEqual(importCalls.count, 2)
        XCTAssertNil(capped)
        XCTAssertEqual(summary.ideaCount, 9)
        XCTAssertEqual(last?.conversationsDone, 40)
        XCTAssertEqual(last?.conversationsTotal, 40)
    }

    func testAFreshRunSendsASmallFirstBatchThenFullOnesInPlanOrder() async throws {
        MockURLProtocol.reset()
        MockURLProtocol.stubs["POST /v1/import"] = .init(
            status: 200,
            body: Data(#"{"newCanonicalEvents":0,"newCognitiveEvents":0,"rejectedExtractions":0,"ideaCount":1}"#.utf8)
        )
        let export = DetectedExport(url: claudeExport(40), kind: .claude, conversationCount: 40, modified: Date())
        let client = APIClient(baseURL: "http://x", credentials: ("u", "t"), session: MockURLProtocol.makeSession())
        // A plan of 22 conversations, newest first (here: reverse id order), from a file of 40.
        let plan = (18..<40).reversed().map { "c\($0)" }
        var seen: [BackfillProgress] = []
        _ = try await Backfill.run(export, ids: plan, client: client, progress: { seen.append($0) })

        // 5 first (first ideas fast), then 15, then the last 2 -- and only the planned 22.
        XCTAssertEqual(seen.map(\.conversationsDone), [5, 20, 22])
        XCTAssertEqual(seen.last?.conversationsTotal, 22)
        XCTAssertEqual(MockURLProtocol.capturedRequests.filter { $0.url?.path == "/v1/import" }.count, 3)
    }

    func testRunWithStartingAtBeyondTheEndDoesNoWork() async throws {
        MockURLProtocol.reset()
        let export = DetectedExport(url: claudeExport(3), kind: .claude, conversationCount: 3, modified: Date())
        let client = APIClient(baseURL: "http://x", credentials: ("u", "t"), session: MockURLProtocol.makeSession())

        let (_, capped) = try await Backfill.run(
            export, ids: ["c0", "c1", "c2"], client: client, progress: { _ in }, startingAt: 99
        )
        XCTAssertNil(capped)
        XCTAssertTrue(MockURLProtocol.capturedRequests.filter { $0.url?.path == "/v1/import" }.isEmpty)
    }
}
