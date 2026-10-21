import XCTest
@testable import ThreadMac

final class IdeaCorrectionTests: XCTestCase {
    func testSplitNeedsSomeButNotAllThoughts() {
        XCTAssertFalse(SplitSelection.isValid(selected: 0, total: 3))
        XCTAssertTrue(SplitSelection.isValid(selected: 1, total: 3))
        XCTAssertTrue(SplitSelection.isValid(selected: 2, total: 3))
        XCTAssertFalse(SplitSelection.isValid(selected: 3, total: 3))
        XCTAssertFalse(SplitSelection.isValid(selected: 1, total: 1))
    }

    func testCorrectionIdsAreDistinct() {
        XCTAssertNotEqual(IdeaCorrection.merge(ideaId: "a").id, IdeaCorrection.split(ideaId: "a").id)
    }
}
