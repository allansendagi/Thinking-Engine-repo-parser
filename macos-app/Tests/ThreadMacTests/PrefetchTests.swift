import XCTest
@testable import ThreadMac

final class PrefetchTests: XCTestCase {
    private func trace(_ id: String, title: String, formulation: String, updatedAt: String) throws -> IdeaTrace {
        let json = """
        {"idea":{"id":"\(id)","title":"\(title)","state":"developing","currentFormulation":"\(formulation)","evolution":[],
                 "openLoops":[],"decisions":[],"relatedIdeaIds":[],"createdAt":"2026-10-01T00:00:00Z","updatedAt":"\(updatedAt)"},
         "provenance":[]}
        """
        return try JSONDecoder().decode(IdeaTrace.self, from: Data(json.utf8))
    }

    func testFetchesMissingAndChangedIdeasMostRecentFirst() throws {
        let ideas = [
            IdeaSummary(id: "same", title: "A", state: "developing", currentFormulation: "a"),
            IdeaSummary(id: "missing", title: "B", state: "developing", currentFormulation: "b"),
            IdeaSummary(id: "retitled", title: "C2", state: "developing", currentFormulation: "c"),
            IdeaSummary(id: "newstep", title: "D", state: "developing", currentFormulation: "d"),
        ]
        let cached = [
            "same": try trace("same", title: "A", formulation: "a", updatedAt: "2026-10-10T00:00:00Z"),
            "retitled": try trace("retitled", title: "C", formulation: "c", updatedAt: "2026-10-10T00:00:00Z"),
            "newstep": try trace("newstep", title: "D", formulation: "d", updatedAt: "2026-10-10T00:00:00Z"),
        ]
        let changes = [
            ThinkingStateResponse.RecentChange(ideaId: "newstep", ideaTitle: "D", formulation: "d", createdAt: "2026-10-18T00:00:00Z"),
            ThinkingStateResponse.RecentChange(ideaId: "missing", ideaTitle: "B", formulation: "b", createdAt: "2026-10-12T00:00:00Z"),
            ThinkingStateResponse.RecentChange(ideaId: "same", ideaTitle: "A", formulation: "a", createdAt: "2026-10-09T00:00:00Z"),
        ]
        XCTAssertEqual(tracesToPrefetch(ideas: ideas, recentChanges: changes, cached: cached), ["newstep", "missing", "retitled"])
    }
}
