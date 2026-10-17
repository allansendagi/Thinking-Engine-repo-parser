import XCTest
@testable import ThreadMac

final class TasteTests: XCTestCase {

    // MARK: decoding what the server sends

    func testDecodesTheServersReport() throws {
        let json = """
        {"ready":true,"keeps":7,"notIdeas":6,"acceptanceRate":0.85,"window":20,
         "ideas":[{"ideaId":"a","tier":"likely","score":0.8},
                  {"ideaId":"b","tier":"unlikely","score":0.1},
                  {"ideaId":"c","tier":"confirmed","score":1}]}
        """.data(using: .utf8)!
        let r = try JSONDecoder().decode(TasteReport.self, from: json)
        XCTAssertTrue(r.ready)
        XCTAssertEqual(r.acceptanceRate, 0.85)
        XCTAssertEqual(r.ideas.map(\.tier), [.likely, .unlikely, .confirmed])
    }

    func testAnUnknownTierFromANewerBackendIsJustASuggestionNotAnError() throws {
        let json = #"{"ready":true,"keeps":6,"notIdeas":6,"acceptanceRate":null,"window":20,"ideas":[{"ideaId":"x","tier":"somethingNew","score":null}]}"#.data(using: .utf8)!
        let r = try JSONDecoder().decode(TasteReport.self, from: json)
        XCTAssertEqual(r.ideas.first?.tier, .suggested)
        XCTAssertNil(r.acceptanceRate)
    }

    // MARK: the Maybe tray rule

    private func report(ready: Bool = true, _ ideas: [(String, TasteTier)]) -> TasteReport {
        TasteReport(ready: ready, keeps: 6, notIdeas: 6, acceptanceRate: nil, window: 20,
                    ideas: ideas.map { TasteIdea(ideaId: $0.0, tier: $0.1) })
    }

    func testOnlyUnlikelyIdeasWaitInTheTray() {
        let r = report([("a", .likely), ("b", .unlikely), ("c", .unsure), ("d", .suggested), ("e", .confirmed)])
        XCTAssertEqual(maybeIdeaIDs(report: r, pendingEdits: []), ["b"])
    }

    func testNothingIsHeldBackUntilThereAreEnoughAnswersToTrustTheGuess() {
        let r = report(ready: false, [("b", .unlikely)])
        XCTAssertTrue(maybeIdeaIDs(report: r, pendingEdits: []).isEmpty)
        XCTAssertTrue(maybeIdeaIDs(report: nil, pendingEdits: []).isEmpty)   // older backend / offline
    }

    func testKeepingAnIdeaMovesItOutOfTheTrayAtOnceEvenBeforeItSyncs() {
        let r = report([("b", .unlikely)])
        XCTAssertEqual(maybeIdeaIDs(report: r, pendingEdits: []), ["b"])
        XCTAssertTrue(maybeIdeaIDs(report: r, pendingEdits: [.keep("b")]).isEmpty)
    }

    func testConfirmedMeansKeptOnTheServerOrKeptHereAndQueued() {
        let r = report([("a", .confirmed), ("b", .unlikely)])
        XCTAssertTrue(isConfirmedIdea("a", report: r, pendingEdits: []))
        XCTAssertFalse(isConfirmedIdea("b", report: r, pendingEdits: []))
        XCTAssertTrue(isConfirmedIdea("b", report: r, pendingEdits: [.keep("b")]))
        XCTAssertFalse(isConfirmedIdea("zzz", report: nil, pendingEdits: []))
    }

    // MARK: the queue

    func testKeepingTwiceQueuesOnce() {
        let q = coalesced(coalesced([], adding: .keep("a")), adding: .keep("a"))
        XCTAssertEqual(q.count, 1)
    }

    func testNotAnIdeaAfterKeepSupersedesTheKeep() {
        let q = coalesced(coalesced([], adding: .keep("a")), adding: .delete("a"))
        XCTAssertEqual(q.count, 1)
        if case .delete = q[0].kind {} else { XCTFail("the later word should win") }
    }

    func testKeepNeverChangesWhatTheListShows() {
        let s = ThinkingStateResponse(topic: nil,
            currentIdeas: [IdeaSummary(id: "a", title: "A", state: "developing", currentFormulation: "f", latestSource: nil)],
            recentChanges: [], decisions: [], openLoops: [], contradictions: [], relatedIdeas: [])
        let out = apply(.keep, to: s, ideaId: "a")
        XCTAssertEqual(out.currentIdeas.map(\.id), ["a"])
        XCTAssertEqual(out.currentIdeas.first?.title, "A")
    }

    func testPendingKeepSurvivesARelaunch() throws {
        let data = try JSONEncoder().encode([PendingEdit.keep("a")])
        let back = try JSONDecoder().decode([PendingEdit].self, from: data)
        XCTAssertEqual(back.first?.ideaId, "a")
        if case .keep = back[0].kind {} else { XCTFail("kind lost in persistence") }
    }
}
