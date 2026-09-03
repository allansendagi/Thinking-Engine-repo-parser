import XCTest
@testable import ThreadMac

final class LocalEditsTests: XCTestCase {

    private func idea(_ id: String, _ title: String, state: String = "developing") -> IdeaSummary {
        IdeaSummary(id: id, title: title, state: state, currentFormulation: "f-\(id)", latestSource: nil)
    }
    private func loopEntry(_ loopId: String, idea: String, ideaTitle: String, resolved: Bool = false) -> ThinkingStateResponse.OpenLoopEntry {
        .init(ideaId: idea, ideaTitle: ideaTitle, loopId: loopId, statement: "q-\(loopId)",
              resolved: resolved, createdAt: nil, latestSource: nil)
    }
    private func state(ideas: [IdeaSummary], loops: [ThinkingStateResponse.OpenLoopEntry] = []) -> ThinkingStateResponse {
        .init(topic: nil, currentIdeas: ideas, recentChanges: [], decisions: [],
              openLoops: loops, contradictions: [], relatedIdeas: [])
    }
    private func trace(_ id: String, title: String, state: String = "developing", loops: [OpenLoop] = []) -> IdeaTrace {
        IdeaTrace(
            idea: IdeaDetail(id: id, title: title, state: state, currentFormulation: "f",
                             evolution: [], openLoops: loops, decisions: [], relatedIdeaIds: [],
                             createdAt: "2026-01-01", updatedAt: "2026-01-02"),
            provenance: []
        )
    }

    // MARK: apply to ThinkingStateResponse

    func testRenameUpdatesIdeaAndItsLoopTitles() {
        let s = state(
            ideas: [idea("a", "Old"), idea("b", "Other")],
            loops: [loopEntry("l1", idea: "a", ideaTitle: "Old"), loopEntry("l2", idea: "b", ideaTitle: "Other")]
        )
        let out = apply(.rename("New"), to: s, ideaId: "a")
        XCTAssertEqual(out.currentIdeas.first { $0.id == "a" }?.title, "New")
        XCTAssertEqual(out.currentIdeas.first { $0.id == "b" }?.title, "Other")
        XCTAssertEqual(out.openLoops.first { $0.loopId == "l1" }?.ideaTitle, "New")
        XCTAssertEqual(out.openLoops.first { $0.loopId == "l2" }?.ideaTitle, "Other")
    }

    func testSetStateUpdatesOnlyTheTargetIdea() {
        let s = state(ideas: [idea("a", "A", state: "developing"), idea("b", "B", state: "developing")])
        let out = apply(.setState("contested"), to: s, ideaId: "a")
        XCTAssertEqual(out.currentIdeas.first { $0.id == "a" }?.state, "contested")
        XCTAssertEqual(out.currentIdeas.first { $0.id == "b" }?.state, "developing")
    }

    func testResolveLoopFlipsResolved() {
        let s = state(ideas: [idea("a", "A")], loops: [loopEntry("l1", idea: "a", ideaTitle: "A", resolved: false)])
        let out = apply(.resolveLoop(loopId: "l1", resolved: true), to: s, ideaId: "a")
        XCTAssertTrue(out.openLoops.first { $0.loopId == "l1" }?.resolved ?? false)
    }

    func testDeleteRemovesIdeaAndItsLoops() {
        let s = state(
            ideas: [idea("a", "A"), idea("b", "B")],
            loops: [loopEntry("l1", idea: "a", ideaTitle: "A"), loopEntry("l2", idea: "b", ideaTitle: "B")]
        )
        let out = apply(.delete, to: s, ideaId: "a")
        XCTAssertEqual(out.currentIdeas.map(\.id), ["b"])
        XCTAssertEqual(out.openLoops.map(\.loopId), ["l2"])
    }

    func testApplyAllFoldsInOrder() {
        let s = state(ideas: [idea("a", "A", state: "developing")])
        let edits = [PendingEdit.rename("a", "A2"), PendingEdit.setState("a", "established")]
        let out = applyAll(edits, to: s)
        XCTAssertEqual(out.currentIdeas.first?.title, "A2")
        XCTAssertEqual(out.currentIdeas.first?.state, "established")
    }

    // MARK: apply to IdeaTrace

    func testApplyAllToTraceOverlaysOnlyMatchingIdea() {
        let t = trace("a", title: "A", loops: [OpenLoop(id: "l1", statement: "q", createdAt: "x", resolved: false)])
        let edits = [
            PendingEdit.rename("a", "A-new"),
            PendingEdit.setState("a", "rejected"),
            PendingEdit.resolveLoop("a", loopId: "l1", resolved: true),
            PendingEdit.rename("other", "ignored"),
        ]
        let out = applyAll(edits, to: t)
        XCTAssertEqual(out.idea.title, "A-new")
        XCTAssertEqual(out.idea.state, "rejected")
        XCTAssertTrue(out.idea.openLoops.first?.resolved ?? false)
    }

    // MARK: coalesced

    func testSecondRenameReplacesFirst() {
        var q = coalesced([], adding: .rename("a", "First"))
        q = coalesced(q, adding: .rename("a", "Second"))
        XCTAssertEqual(q.count, 1)
        if case .rename(let title) = q.first?.kind { XCTAssertEqual(title, "Second") } else { XCTFail() }
    }

    func testDeleteSupersedesEarlierEditsForThatIdea() {
        var q = coalesced([], adding: .rename("a", "X"))
        q = coalesced(q, adding: .setState("a", "contested"))
        q = coalesced(q, adding: .rename("b", "keep me"))
        q = coalesced(q, adding: .delete("a"))
        XCTAssertEqual(q.count, 2)
        XCTAssertEqual(q.map(\.ideaId).sorted(), ["a", "b"])
        if case .delete = q.first(where: { $0.ideaId == "a" })!.kind {} else { XCTFail("a should be a delete") }
    }

    func testResolveLoopReplacesPriorForSameLoop() {
        var q = coalesced([], adding: .resolveLoop("a", loopId: "l1", resolved: true))
        q = coalesced(q, adding: .resolveLoop("a", loopId: "l1", resolved: false))
        q = coalesced(q, adding: .resolveLoop("a", loopId: "l2", resolved: true))
        XCTAssertEqual(q.count, 2)
        if case .resolveLoop(_, let resolved) = q.first(where: {
            if case .resolveLoop(let l, _) = $0.kind { return l == "l1" }; return false
        })!.kind { XCTAssertFalse(resolved) } else { XCTFail() }
    }

    func testPendingEditRoundTrips() throws {
        let edits: [PendingEdit] = [
            .rename("a", "T"), .setState("a", "dormant"),
            .resolveLoop("a", loopId: "l1", resolved: true), .delete("a"),
        ]
        let data = try JSONEncoder().encode(edits)
        XCTAssertEqual(try JSONDecoder().decode([PendingEdit].self, from: data), edits)
    }
}
