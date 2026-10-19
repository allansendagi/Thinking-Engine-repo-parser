import XCTest
@testable import ThreadMac

final class WidgetFeedTests: XCTestCase {
    private func state(_ ideas: [(String, String, String?)], touched: [String: String] = [:], loops: [Bool] = []) throws -> ThinkingStateResponse {
        let current = ideas.map { ["id": $0.0, "title": $0.1, "state": "developing", "currentFormulation": $0.1, "latestSource": $0.2 as Any] }
        let changes = touched.map { ["ideaId": $0.key, "ideaTitle": "t", "formulation": "f", "createdAt": $0.value] }
        let open = loops.enumerated().map { ["ideaId": "a", "ideaTitle": "t", "loopId": "l\($0.offset)", "statement": "q", "resolved": $0.element] as [String: Any] }
        let json: [String: Any] = ["topic": NSNull(), "currentIdeas": current, "recentChanges": changes, "decisions": [], "openLoops": open, "contradictions": [], "relatedIdeas": []]
        return try JSONDecoder().decode(ThinkingStateResponse.self, from: JSONSerialization.data(withJSONObject: json))
    }

    func testNewestTouchedFirstWithSourceAndOpenQuestionCount() throws {
        let s = try state(
            [("a", "Old idea", "chatgpt"), ("b", "New idea", "claude"), ("c", "Never touched", nil)],
            touched: ["a": "2026-10-01T09:00:00Z", "b": "2026-10-19T09:00:00Z"],
            loops: [false, true, false]
        )
        let snap = WidgetFeed.snapshot(from: s)
        XCTAssertEqual(snap.ideas.map(\.id), ["b", "a", "c"])
        XCTAssertEqual(snap.ideas.first?.source, "Claude")
        XCTAssertEqual(snap.openLoops, 2, "resolved questions don't count")
    }

    func testMaybeTrayIdeasAreLeftOutAndTheListIsCapped() throws {
        let many = (0..<10).map { ("i\($0)", "Idea \($0)", "claude" as String?) }
        let snap = WidgetFeed.snapshot(from: try state(many), excluding: ["i0"])
        XCTAssertEqual(snap.ideas.count, WidgetFeed.maxIdeas)
        XCTAssertFalse(snap.ideas.contains { $0.id == "i0" })
    }

    /// The widget reads exactly what the app writes (the widget compiles this same file).
    func testSnapshotRoundTripsThroughTheSharedStore() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("widget-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        WidgetStore.directoryOverride = dir
        defer { WidgetStore.directoryOverride = nil; try? FileManager.default.removeItem(at: dir) }
        let snap = WidgetSnapshot(updatedAt: Date(timeIntervalSince1970: 1_800_000_000),
                                  ideas: [.init(id: "1", title: "Authority should be checkable", source: "Claude", touched: Date(timeIntervalSince1970: 1_799_990_000))],
                                  openLoops: 2)
        XCTAssertTrue(WidgetStore.save(snap))
        XCTAssertEqual(WidgetStore.load(), snap)
        WidgetStore.clear()
        XCTAssertNil(WidgetStore.load())
    }
}
