import XCTest
@testable import ThreadMac

final class RevisitGroupsTests: XCTestCase {
    private func item(_ loop: String, idea: String, _ title: String, _ text: String, via: String? = nil) throws -> ThinkingStateResponse.Revisit {
        let v = via.map { "\"\($0)\"" } ?? "null"
        let json = #"{"ideaId":"\#(idea)","ideaTitle":"\#(title)","loopId":"\#(loop)","statement":"\#(text)","raisedAt":"2026-10-19T09:00:00Z","backOnTopicAt":"2026-10-21T09:00:00Z","via":\#(v)}"#
        return try JSONDecoder().decode(ThinkingStateResponse.Revisit.self, from: Data(json.utf8))
    }

    func testNothingToShow() {
        XCTAssertTrue(revisitGroups([]).isEmpty)
    }

    func testStaysFlatWhileEveryIdeaHasOneQuestion() throws {
        let groups = revisitGroups([
            try item("l1", idea: "a", "Per-seat pricing", "Do guests count?"),
            try item("l2", idea: "b", "First hire", "In the office daily?"),
        ])
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups[0].label, "Open questions")
        XCTAssertNil(groups[0].section)
        XCTAssertEqual(groups[0].rows.count, 2)
        XCTAssertTrue(groups[0].rows[0].meta.contains("Per-seat pricing"), "flat rows say which idea they belong to")
    }

    func testGroupsUnderTheIdeaOnceAnyIdeaHasTwoQuestions() throws {
        let groups = revisitGroups([
            try item("l1", idea: "a", "Per-seat pricing", "Do guests count?"),
            try item("l2", idea: "b", "First hire", "In the office daily?"),
            try item("l3", idea: "a", "Per-seat pricing", "Yearly discount?"),
        ])
        XCTAssertEqual(groups.map(\.label), ["Per-seat pricing", "First hire"], "ideas in the order their first question appears")
        XCTAssertEqual(groups.map(\.rows.count), [2, 1])
        XCTAssertTrue(groups.allSatisfy { $0.section == "Open questions" })
        XCTAssertEqual(groups.map(\.leadsSection), [true, false], "the section heading shows once")
        XCTAssertFalse(groups[0].rows[0].meta.contains("Per-seat pricing"), "the idea's name is not repeated under each question")
    }

    func testEveryQuestionAppearsOnceAndKeepsItsOrder() throws {
        let input = [
            try item("l1", idea: "a", "A", "one"), try item("l2", idea: "b", "B", "two"),
            try item("l3", idea: "a", "A", "three"), try item("l4", idea: "a", "A", "four"),
        ]
        let rows = revisitGroups(input).flatMap(\.rows)
        XCTAssertEqual(Set(rows.map(\.id)), Set(input.map { "loop:" + $0.loopId }))
        XCTAssertEqual(rows.count, input.count)
        XCTAssertEqual(revisitGroups(input)[0].rows.map(\.title), ["one", "three", "four"])
    }

    func testTheReasonItCameBackIsKeptInBothModes() throws {
        let flat = revisitGroups([try item("l1", idea: "a", "Per-seat pricing", "Q?", via: "SOC 2")])
        XCTAssertTrue(flat[0].rows[0].meta.contains("Back on it via SOC 2"))
        let grouped = revisitGroups([
            try item("l1", idea: "a", "Per-seat pricing", "Q?", via: "SOC 2"), try item("l2", idea: "a", "Per-seat pricing", "R?"),
        ])
        XCTAssertTrue(grouped[0].rows[0].meta.contains("Back on it via SOC 2"))
        XCTAssertFalse(grouped[0].rows[1].meta.contains("Back on it"))
    }
}
