import XCTest
@testable import ThreadMac

final class ExternalActionsTests: XCTestCase {
    private func parse(_ s: String) -> ThreadAction? {
        ThreadAction.parse(URL(string: s)!)
    }

    func testRecallFromQuery() {
        XCTAssertEqual(parse("thread://recall?q=computable%20authority"), .recall("computable authority"))
        XCTAssertEqual(parse("thread://search?query=NOMOS"), .recall("NOMOS"))
        XCTAssertEqual(parse("thread://recall/computable%20authority"), .recall("computable authority"))
    }

    func testOpenIdea() {
        XCTAssertEqual(parse("thread://idea/abc123"), .openIdea("abc123"))
        XCTAssertEqual(parse("thread://idea?id=abc123"), .openIdea("abc123"))
        // Paste-sourced ids contain `::` -- must survive a round-trip through the URL.
        XCTAssertEqual(parse("thread://idea/conv%3A%3A4"), .openIdea("conv::4"))
    }

    func testOpenLoops() {
        XCTAssertEqual(parse("thread://loops"), .openLoops)
        XCTAssertEqual(parse("thread://open-loops"), .openLoops)
    }

    func testContinueIdea() {
        XCTAssertEqual(parse("thread://continue?idea=abc123"), .continueIdea("abc123"))
        XCTAssertEqual(parse("thread://continue/abc123"), .continueIdea("abc123"))
    }

    func testContinueTopic() {
        XCTAssertEqual(
            parse("thread://continue?topic=computable%20authority"),
            .continueTopic("computable authority")
        )
        // topic wins over a stray id when both are present
        XCTAssertEqual(parse("thread://continue?topic=x&idea=abc"), .continueTopic("x"))
    }

    func testRejectsJunk() {
        XCTAssertNil(parse("thread://recall"))               // no text
        XCTAssertNil(parse("thread://idea"))                 // no id
        XCTAssertNil(parse("thread://continue"))             // no id
        XCTAssertNil(parse("thread://bogus?q=x"))            // unknown host
        XCTAssertNil(ThreadAction.parse(URL(string: "https://threadnow.app/recall?q=x")!))  // wrong scheme
        XCTAssertNil(parse("thread://recall?q=%20%20"))      // whitespace-only
    }
}
