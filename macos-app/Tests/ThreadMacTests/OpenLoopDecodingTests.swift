import XCTest
@testable import ThreadMac

final class OpenLoopDecodingTests: XCTestCase {
    private func decode(_ json: String) throws -> OpenLoop {
        try JSONDecoder().decode(OpenLoop.self, from: Data(json.utf8))
    }

    func testAnsweredByIsReadWhenTheServerSendsIt() throws {
        let loop = try decode(#"{"id":"l1","statement":"Do guests count?","createdAt":"2026-10-20T10:00:00Z","resolved":true,"answeredBy":"Five free guests."}"#)
        XCTAssertTrue(loop.resolved)
        XCTAssertEqual(loop.answeredBy, "Five free guests.")
    }

    func testAnOlderServerWithoutTheFieldStillDecodes() throws {
        let loop = try decode(#"{"id":"l1","statement":"Do guests count?","createdAt":"2026-10-20T10:00:00Z","resolved":true}"#)
        XCTAssertNil(loop.answeredBy)
    }

    func testAnOpenQuestionHasNoAnswer() throws {
        let loop = try decode(#"{"id":"l2","statement":"Yearly discount?","createdAt":"2026-10-20T10:05:00Z","resolved":false}"#)
        XCTAssertFalse(loop.resolved)
        XCTAssertNil(loop.answeredBy)
    }
}
