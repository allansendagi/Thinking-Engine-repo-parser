import XCTest
@testable import ThreadMac

final class RevisitGroupsTests: XCTestCase {
    /// The grouping rules, with the Recent tab's one-question cap lifted.
    private func revisitGroups(all: [ThinkingStateResponse.Revisit]) -> [IdeaRowGroup] {
        ThreadMac.revisitGroups(all, maxQuestions: .max)
    }

    func testRecentShowsOneQuestionNamingItsIdea() throws {
        let groups = ThreadMac.revisitGroups([
            try item("l1", idea: "a", "Per-seat pricing", "Do guests count?"),
            try item("l2", idea: "a", "Per-seat pricing", "Yearly discount?"),
            try item("l3", idea: "b", "First hire", "In the office daily?"),
        ])
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].label, "Still unanswered")
        XCTAssertEqual(groups[0].rows.map(\.title), ["Do guests count?"], "the server's top-ranked question only")
        XCTAssertTrue(groups[0].rows[0].meta.contains("Per-seat pricing"), "it says which idea it belongs to")
    }

    private func item(_ loop: String, idea: String, _ title: String, _ text: String, via: String? = nil) throws -> ThinkingStateResponse.Revisit {
        let v = via.map { "\"\($0)\"" } ?? "null"
        let json = #"{"ideaId":"\#(idea)","ideaTitle":"\#(title)","loopId":"\#(loop)","statement":"\#(text)","raisedAt":"2026-10-19T09:00:00Z","backOnTopicAt":"2026-10-21T09:00:00Z","via":\#(v)}"#
        return try JSONDecoder().decode(ThinkingStateResponse.Revisit.self, from: Data(json.utf8))
    }

    func testNothingToShow() {
        XCTAssertTrue(revisitGroups(all: []).isEmpty)
    }

    func testStaysFlatWhileEveryIdeaHasOneQuestion() throws {
        let groups = revisitGroups(all: [
            try item("l1", idea: "a", "Per-seat pricing", "Do guests count?"),
            try item("l2", idea: "b", "First hire", "In the office daily?"),
        ])
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].label, "Still unanswered")
        XCTAssertNil(groups[0].section)
        XCTAssertEqual(groups[0].rows.count, 2)
        XCTAssertTrue(groups[0].rows[0].meta.contains("Per-seat pricing"), "flat rows say which idea they belong to")
    }

    func testGroupsUnderTheIdeaOnceAnyIdeaHasTwoQuestions() throws {
        let groups = revisitGroups(all: [
            try item("l1", idea: "a", "Per-seat pricing", "Do guests count?"),
            try item("l2", idea: "b", "First hire", "In the office daily?"),
            try item("l3", idea: "a", "Per-seat pricing", "Yearly discount?"),
        ])
        XCTAssertEqual(groups.map(\.label), ["Per-seat pricing", "First hire"], "ideas in the order their first question appears")
        XCTAssertEqual(groups.map(\.rows.count), [2, 1])
        XCTAssertTrue(groups.allSatisfy { $0.section == "Still unanswered" })
        XCTAssertEqual(groups.map(\.leadsSection), [true, false], "the section heading shows once")
        XCTAssertFalse(groups[0].rows[0].meta.contains("Per-seat pricing"), "the idea's name is not repeated under each question")
    }

    func testEveryQuestionAppearsOnceAndKeepsItsOrder() throws {
        let input = [
            try item("l1", idea: "a", "A", "one"), try item("l2", idea: "b", "B", "two"),
            try item("l3", idea: "a", "A", "three"), try item("l4", idea: "a", "A", "four"),
        ]
        let rows = revisitGroups(all: input).flatMap(\.rows)
        XCTAssertEqual(Set(rows.map(\.id)), Set(input.map { "loop:" + $0.loopId }))
        XCTAssertEqual(rows.count, input.count)
        XCTAssertEqual(revisitGroups(all: input)[0].rows.map(\.title), ["one", "three", "four"])
    }

    func testTheReasonItCameBackIsKeptInBothModes() throws {
        let flat = revisitGroups(all: [try item("l1", idea: "a", "Per-seat pricing", "Q?", via: "SOC 2")])
        XCTAssertTrue(flat[0].rows[0].meta.contains("Back on it via SOC 2"))
        let grouped = revisitGroups(all: [
            try item("l1", idea: "a", "Per-seat pricing", "Q?", via: "SOC 2"), try item("l2", idea: "a", "Per-seat pricing", "R?"),
        ])
        XCTAssertTrue(grouped[0].rows[0].meta.contains("Back on it via SOC 2"))
        XCTAssertFalse(grouped[0].rows[1].meta.contains("Back on it"))
    }

    func testShowsAtMostThreeIdeasKeepingTheirQuestions() throws {
        let input = [
            try item("l1", idea: "a", "A", "q1"), try item("l2", idea: "b", "B", "q2"),
            try item("l3", idea: "c", "C", "q3"), try item("l4", idea: "d", "D", "q4"),
            try item("l5", idea: "a", "A", "q5"),
        ]
        let groups = revisitGroups(all: input)
        XCTAssertEqual(groups.map(\.label), ["A", "B", "C"])
        XCTAssertEqual(groups.flatMap(\.rows).count, 4, "idea A keeps both of its questions; D is left for Open loops")
        XCTAssertEqual(revisitGroups(all: Array(input.prefix(3))).first?.rows.count, 3, "three ideas with one question each stay flat")
    }
}
