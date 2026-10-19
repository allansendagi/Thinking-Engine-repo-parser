import XCTest
@testable import ThreadMac

final class PinningTests: XCTestCase {
    private func row(_ id: String, _ when: String) -> IdeaRow {
        IdeaRow(id: id, title: id, snippet: nil, meta: "", isLoop: false, ideaId: id, when: when)
    }

    /// Pinning has to show somewhere you'd look: a pinned idea leads the list it's in, in its own
    /// "Pinned" group, and isn't repeated in the date groups below. (It used to live only under
    /// All -> Ideas, which stopped being the default view, so pins seemed to do nothing.)
    func testPinnedIdeasLeadAndAreNotRepeated() {
        let now = ISO8601DateFormatter().string(from: Date())
        let old = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-40 * 86_400))
        let groups = pinnedThenDated([row("new", now), row("old", old), row("other", now)], isPinned: { $0 == "old" })
        XCTAssertEqual(groups.first?.label, "Pinned")
        XCTAssertEqual(groups.first?.rows.map(\.id), ["old"])
        XCTAssertEqual(groups.dropFirst().flatMap(\.rows).map(\.id).sorted(), ["new", "other"])
    }

    func testNothingPinnedMeansNoPinnedGroup() {
        let now = ISO8601DateFormatter().string(from: Date())
        let groups = pinnedThenDated([row("a", now)], isPinned: { _ in false })
        XCTAssertFalse(groups.contains { $0.label == "Pinned" })
        XCTAssertEqual(groups.flatMap(\.rows).map(\.id), ["a"])
    }
}
