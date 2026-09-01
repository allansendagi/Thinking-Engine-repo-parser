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
