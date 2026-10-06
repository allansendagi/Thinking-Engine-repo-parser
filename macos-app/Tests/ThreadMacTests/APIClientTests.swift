import XCTest
@testable import ThreadMac

final class APIClientTests: XCTestCase {
    override func setUp() { MockURLProtocol.reset() }

    func testGetThinkingStateDecodesRealBackendShape() async throws {
        // This is the exact JSON shape src/mcp/tools.ts's getThreadState returns (see
        // src/mcp/tools.test.ts) -- if the backend's shape drifts, this test should be the one
        // that catches it, not a silent runtime crash in the app.
        let json = """
        {
          "topic": null,
          "currentIdeas": [{"id":"idea_1","title":"Computable Authority","state":"developing","currentFormulation":"..."}],
          "recentChanges": [],
          "decisions": [],
          "openLoops": [{"ideaId":"idea_1","ideaTitle":"Computable Authority","loopId":"loop_1","statement":"Who verifies?","resolved":false}],
          "contradictions": [],
          "relatedIdeas": []
        }
        """
        MockURLProtocol.stubs["GET /v1/thinking-state"] = .init(status: 200, body: Data(json.utf8))

        let client = APIClient(baseURL: "http://x", credentials: ("user_abc", "tok"), session: MockURLProtocol.makeSession())
        let state = try await client.getThinkingState()

        XCTAssertEqual(state.currentIdeas.count, 1)
        XCTAssertEqual(state.currentIdeas[0].title, "Computable Authority")
        XCTAssertEqual(state.openLoops.count, 1)
        XCTAssertFalse(state.openLoops[0].resolved)
    }

    func testAuthorizationHeaderIsSentCorrectly() async throws {
        MockURLProtocol.stubs["GET /v1/thinking-state"] = .init(
            status: 200,
            body: Data(#"{"topic":null,"currentIdeas":[],"recentChanges":[],"decisions":[],"openLoops":[],"contradictions":[],"relatedIdeas":[]}"#.utf8)
        )
        let client = APIClient(baseURL: "http://x", credentials: ("user_abc", "tok123"), session: MockURLProtocol.makeSession())
        _ = try await client.getThinkingState()

        let sent = MockURLProtocol.capturedRequests.first
        XCTAssertEqual(sent?.value(forHTTPHeaderField: "authorization"), "Bearer user_abc:tok123")
    }

    func testHttpErrorSurfacesTheServersErrorMessage() async throws {
        MockURLProtocol.stubs["GET /v1/ideas/idea_missing/trace"] = .init(
            status: 404,
            body: Data(#"{"error":"Idea not found"}"#.utf8)
        )
        let client = APIClient(baseURL: "http://x", credentials: ("user_abc", "tok"), session: MockURLProtocol.makeSession())

        do {
            _ = try await client.traceIdea(id: "idea_missing")
            XCTFail("expected an error to be thrown")
        } catch let error as APIError {
            guard case .http(let status, let message) = error else { return XCTFail("wrong error case") }
            XCTAssertEqual(status, 404)
            XCTAssertEqual(message, "Idea not found")
        }
    }

    func testSearchQueryIsPercentEncoded() async throws {
        MockURLProtocol.stubs["GET /v1/ideas?q=authority%20boundaries"] = .init(status: 200, body: Data("[]".utf8))
        let client = APIClient(baseURL: "http://x", credentials: ("user_abc", "tok"), session: MockURLProtocol.makeSession())
        let results = try await client.searchIdeas(query: "authority boundaries")
        XCTAssertEqual(results.count, 0)
    }

    func testRenameSendsPatchWithTitleBody() async throws {
        let responseJson = """
        {"id":"idea_1","title":"New Title","state":"developing","currentFormulation":"x","evolution":[],"openLoops":[],"decisions":[],"relatedIdeaIds":[],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}
        """
        MockURLProtocol.stubs["PATCH /v1/ideas/idea_1"] = .init(status: 200, body: Data(responseJson.utf8))
        let client = APIClient(baseURL: "http://x", credentials: ("user_abc", "tok"), session: MockURLProtocol.makeSession())

        let updated = try await client.renameIdea(id: "idea_1", title: "New Title")
        XCTAssertEqual(updated.title, "New Title")

        let sent = MockURLProtocol.capturedRequests.first
        XCTAssertEqual(sent?.httpMethod, "PATCH")
        let bodyString = String(data: sent!.httpBodyOrStream(), encoding: .utf8) ?? ""
        XCTAssertTrue(bodyString.contains("New Title"))
    }
}

private extension URLRequest {
    /// httpBody is nil on requests captured via URLProtocol in some configurations -- pull from
    /// httpBodyStream if needed so the assertion above is reliable either way.
    func httpBodyOrStream() -> Data {
        if let body = httpBody { return body }
        guard let stream = httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4096
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            if read > 0 { data.append(buffer, count: read) } else { break }
        }
        return data
    }
}

/// The app decodes only the options + gaps of the server's thinking map; the rest is ignored.
final class ThinkingMapDecodingTests: XCTestCase {
    func testDecodesTheServerShape() throws {
        let json = """
        {"map":{"ideaId":"idea_1","title":"Pricing","governingThought":"Annual plans only.",
          "questions":[],"reasons":[],"decisions":[],"history":[],
          "options":[{"statement":"Bill per workspace.","status":"rejected"},{"statement":"Annual plans only.","status":"chosen"}],
          "gaps":[{"kind":"decision-without-reasons","message":"You decided, but the reasons weren't captured."}]},
         "handoff":"Situation: ..."}
        """
        struct Wrap: Decodable { let map: ThinkingMap }
        let map = try JSONDecoder().decode(Wrap.self, from: Data(json.utf8)).map
        XCTAssertEqual(map.options.map(\.status), ["rejected", "chosen"])
        XCTAssertEqual(map.gaps.first?.kind, "decision-without-reasons")
        XCTAssertFalse(map.isEmpty)
    }
}

/// The "Your data" screen decodes exactly what the server sends (shapes taken from the backend's
/// privacy e2e test), including a conversation with a preview and an old server without one.
final class YourDataDecodingTests: XCTestCase {
    func testDecodesDataSummary() throws {
        let json = """
        {"stored":{"conversations":214,"messages":1480,"sources":{"chatgpt":200,"claude":14},"ideas":53,
          "thoughts":120,"setAsideThoughts":30,"openQuestions":9,"decisions":4,"vectors":150,
          "vectorModels":["apple:nlcontextual"],"corrections":2,"waitingForAi":8750,"evidenceRecords":214,
          "firstCaptureAt":"2025-01-02T10:00:00.000Z","lastCaptureAt":"2026-10-06T10:00:00.000Z","bytes":4096000},
         "account":{"email":null,"plan":"free"},
         "processors":[{"name":"Anthropic","purpose":"Reads text.","receives":"Conversation text."}],
         "retention":{"rawConversations":"Kept while your account exists.","vectors":"Kept.","backups":"Up to 7 days."}}
        """
        let s = try JSONDecoder().decode(DataSummaryResponse.self, from: Data(json.utf8))
        XCTAssertEqual(s.stored.conversations, 214)
        XCTAssertEqual(s.stored.sources["claude"], 14)
        XCTAssertEqual(s.processors.first?.name, "Anthropic")
        XCTAssertNil(s.account.email)
    }

    func testDecodesReceipts() throws {
        let removal = try JSONDecoder().decode(ConversationRemoval.self, from: Data("""
        {"deleted":true,"removed":{"messages":2,"thoughts":1,"setAsideThoughts":0,"vectors":1,"steps":1,"decisions":0,
          "corrections":1,"evidenceRecords":1,"waitingForAi":0,"ideasRemoved":1,"ideasRewritten":0,"openQuestionsRemoved":0},
         "backups":"Up to 7 days."}
        """.utf8))
        XCTAssertEqual(removal.removed.messages, 2)
        XCTAssertEqual(removal.removed.ideasRemoved, 1)

        let receipt = try JSONDecoder().decode(AccountDeletionReceipt.self, from: Data("""
        {"deleted":true,"data":{"conversations":1,"messages":2,"ideas":1,"thoughts":1,"vectors":1,"corrections":0,
          "evidenceRecords":1,"filesRemoved":2},"account":{"account":1,"devices":2,"signInCodes":0},
         "subscriptionStillActive":false,"backups":"Up to 7 days."}
        """.utf8))
        XCTAssertTrue(receipt.deleted)
        XCTAssertEqual(receipt.data.filesRemoved, 2)
        XCTAssertFalse(receipt.subscriptionStillActive)
    }

    func testConversationSummaryDecodesWithAndWithoutPreview() throws {
        let base = #""conversationId":"c1","source":"chatgpt","sourceUrl":null,"messageCount":4,"firstAt":"2026-10-01T10:00:00.000Z","lastAt":"2026-10-01T10:05:00.000Z","ideas":[]"#
        let withPreview = try JSONDecoder().decode(ConversationSummary.self, from: Data("{\(base),\"preview\":\"Should we charge per seat?\",\"pendingMessages\":2}".utf8))
        XCTAssertEqual(withPreview.preview, "Should we charge per seat?")
        XCTAssertTrue(withPreview.isWaiting)
        let old = try JSONDecoder().decode(ConversationSummary.self, from: Data("{\(base)}".utf8))
        XCTAssertNil(old.preview)
        XCTAssertFalse(old.isWaiting)
    }
}
