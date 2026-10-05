import XCTest
@testable import ThreadMac

/// Recall must never lose a match the Mac already found. The server ranks by word overlap only,
/// so a vague query it can't match must not wipe the on-device meaning-based results.
final class SearchMergeTests: XCTestCase {
    private func r(_ id: String) -> SearchResult {
        SearchResult(id: id, title: id, state: "developing", currentFormulation: "", score: 0)
    }

    func testEmptyServerResultKeepsLocalMatches() {
        let merged = mergeSearchResults(remote: [], local: [r("pricing")])
        XCTAssertEqual(merged.map(\.id), ["pricing"])
    }

    func testServerRankingLeadsAndLocalExtrasFollowWithoutDuplicates() {
        let merged = mergeSearchResults(remote: [r("b"), r("a")], local: [r("a"), r("c")])
        XCTAssertEqual(merged.map(\.id), ["b", "a", "c"])
    }
}
