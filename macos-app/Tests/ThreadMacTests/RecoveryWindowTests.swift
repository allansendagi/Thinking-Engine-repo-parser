import XCTest
@testable import ThreadMac

/// Recovery brings in what the person is working on now: newest first, the last 90 days or the
/// newest 100 conversations (whichever is more), the rest only on request.
final class RecoveryWindowTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 2_000_000_000)
    private func daysAgo(_ d: Double) -> Date { now.addingTimeInterval(-d * 86_400) }

    func testNewestFirstWithUndatedLast() {
        let items: [(id: String, at: Date?)] = [("old", daysAgo(400)), ("none", nil), ("new", daysAgo(1)), ("mid", daysAgo(30))]
        let o = RecoveryWindow.ordered(items, date: { $0.at }, key: { $0.id }).map(\.id)
        XCTAssertEqual(o, ["new", "mid", "old", "none"])
    }

    func testAtLeastTheNewestHundredEvenWhenNothingIsRecent() {
        // Someone away for a year: a date cutoff alone would bring in nothing.
        let items = (0 ..< 150).map { (id: "c\($0)", at: Optional(daysAgo(365 + Double($0)))) }
        let (recent, older) = RecoveryWindow.split(items, date: { $0.at }, now: now)
        XCTAssertEqual(recent.count, 100)
        XCTAssertEqual(older.count, 50)
        XCTAssertEqual(recent.first?.id, "c0")
    }

    func testEverythingFromTheLastNinetyDaysWhenThatIsMore() {
        let items = (0 ..< 300).map { (id: "c\($0)", at: Optional(daysAgo(Double($0) * 0.5))) } // 180 within 90 days
        let (recent, older) = RecoveryWindow.split(items, date: { $0.at }, now: now)
        XCTAssertEqual(recent.count, 181)
        XCTAssertEqual(older.count, 119)
    }

    func testSmallHistoryIsAllRecent() {
        let items = (0 ..< 12).map { (id: "c\($0)", at: Optional(daysAgo(500))) }
        let (recent, older) = RecoveryWindow.split(items, date: { $0.at }, now: now)
        XCTAssertEqual(recent.count, 12)
        XCTAssertTrue(older.isEmpty)
    }

    func testSmallFirstBatchThenFullBatches() {
        XCTAssertEqual(RecoveryWindow.batches(count: 37, size: 15), [0 ..< 5, 5 ..< 20, 20 ..< 35, 35 ..< 37])
        XCTAssertEqual(RecoveryWindow.batches(count: 3, size: 15), [0 ..< 3])
        XCTAssertEqual(RecoveryWindow.batches(count: 0, size: 15), [])
        XCTAssertEqual(RecoveryWindow.batches(count: 20, size: 15, first: 15), [0 ..< 15, 15 ..< 20]) // a resume
    }

    func testExportPlanReadsChatGPTAndClaudeDatesAndSplits() {
        let chatgpt: [Any] = (0 ..< 120).map { i in
            ["id": "g\(i)", "update_time": now.addingTimeInterval(-Double(i) * 86_400 * 2).timeIntervalSince1970] as [String: Any]
        }
        let plan = Backfill.plan(conversations: chatgpt, scope: .recent, now: now)
        XCTAssertEqual(plan.ids.first, "g0")                 // newest first
        XCTAssertEqual(plan.ids.count, 100)                  // 46 within 90 days < 100
        XCTAssertEqual(plan.olderCount, 20)
        let older = Backfill.plan(conversations: chatgpt, scope: .older, now: now)
        XCTAssertEqual(older.ids.count, 20)
        XCTAssertEqual(older.ids.first, "g100")
        XCTAssertTrue(Set(plan.ids).isDisjoint(with: older.ids))

        let iso = ISO8601DateFormatter()
        let claude: [Any] = [
            ["uuid": "a", "updated_at": iso.string(from: daysAgo(10))],
            ["uuid": "b", "updated_at": "2026-10-30T12:00:00.123456Z"],   // fractional seconds
            ["uuid": "c", "created_at": iso.string(from: daysAgo(1))],
        ]
        XCTAssertNotNil(Backfill.exportConversationDate(claude[1]))
        XCTAssertEqual(Backfill.plan(conversations: claude, scope: .recent, now: now).ids.first, "c")
        XCTAssertEqual(Backfill.exportConversationId(["x": 1], index: 7), "index:7")
    }
}

/// A recovery saved by an older build (no plan) must still load -- it then restarts with a fresh
/// newest-first plan instead of resuming an oldest-first index.
final class LegacyRecoveryJobTests: XCTestCase {
    func testAJobSavedBeforePlansStillDecodes() throws {
        let enc = JSONEncoder()
        let modern = BackfillJob(kind: .cursor, sourcePath: nil, sourceModified: nil, conversationsTotal: 9,
                                 conversationsDone: 4, ideaCountAtStart: 0, startedAt: Date(timeIntervalSince1970: 1),
                                 updatedAt: Date(timeIntervalSince1970: 2), scope: .recent, plannedIds: ["a", "b"])
        var obj = try XCTUnwrap(JSONSerialization.jsonObject(with: enc.encode(modern)) as? [String: Any])
        obj.removeValue(forKey: "scope")
        obj.removeValue(forKey: "plannedIds")
        let legacy = try JSONDecoder().decode(BackfillJob.self, from: JSONSerialization.data(withJSONObject: obj))
        XCTAssertNil(legacy.plannedIds)
        XCTAssertNil(legacy.scope)
        XCTAssertEqual(legacy.conversationsDone, 4)
    }
}
