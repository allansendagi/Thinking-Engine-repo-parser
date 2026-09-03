import XCTest
@testable import ThreadMac

final class LocalGraphTests: XCTestCase {

    private func delta(_ title: String, _ formulation: String, target: String = "new",
                       state: String = "developing", q: String? = nil) -> OnDeviceModel.GraphDelta {
        .init(target: target, title: title, formulation: formulation, state: state, openQuestion: q)
    }

    // MARK: fold

    func testFoldNewCreatesIdea() {
        let g = OnDeviceGraph.fold(delta("Local first", "Reads work offline.", q: "What about writes?"),
                                   captureId: "c1", into: .empty)
        XCTAssertEqual(g.ideas.count, 1)
        XCTAssertEqual(g.ideas[0].title, "Local first")
        XCTAssertEqual(g.ideas[0].evolution.map(\.formulation), ["Reads work offline."])
        XCTAssertEqual(g.ideas[0].openQuestions.map(\.statement), ["What about writes?"])
        XCTAssertEqual(g.ideas[0].sourceCaptureIds, ["c1"])
    }

    func testFoldExistingExtendsIt() {
        var g = OnDeviceGraph.fold(delta("Local first", "Reads work offline."), captureId: "c1", into: .empty)
        let id = g.ideas[0].id
        g = OnDeviceGraph.fold(
            delta("Local first", "Reads and writes work offline; sync is a background layer.",
                  target: id, state: "established", q: "Conflict strategy?"),
            captureId: "c2", into: g
        )
        XCTAssertEqual(g.ideas.count, 1)
        XCTAssertEqual(g.ideas[0].formulation, "Reads and writes work offline; sync is a background layer.")
        XCTAssertEqual(g.ideas[0].state, "established")
        XCTAssertEqual(g.ideas[0].evolution.count, 2)
        XCTAssertEqual(g.ideas[0].openQuestions.count, 1)
        XCTAssertEqual(g.ideas[0].sourceCaptureIds, ["c1", "c2"])
    }

    func testFoldUnknownTargetFallsBackToNew() {
        let g = OnDeviceGraph.fold(delta("Orphan", "No parent here.", target: "local_missing"),
                                   captureId: "c1", into: .empty)
        XCTAssertEqual(g.ideas.count, 1)
        XCTAssertTrue(g.ideas[0].id.hasPrefix("local_"))
    }

    func testExtendDoesNotDuplicateSameOpenQuestion() {
        var g = OnDeviceGraph.fold(delta("A", "F1", q: "Who verifies?"), captureId: "c1", into: .empty)
        let id = g.ideas[0].id
        g = OnDeviceGraph.fold(delta("A", "F2", target: id, q: "who verifies?"), captureId: "c2", into: g)
        XCTAssertEqual(g.ideas[0].openQuestions.count, 1)
    }

    // MARK: projection to the shared view shape

    func testAsThinkingStateProjectsIdeasAndLoops() {
        var g = LocalGraph.empty
        g = OnDeviceGraph.fold(delta("First", "F-1", q: "q1"), captureId: "c1", into: g)
        g = OnDeviceGraph.fold(delta("Second", "F-2"), captureId: "c2", into: g)
        let ts = g.asThinkingState()
        XCTAssertEqual(Set(ts.currentIdeas.map(\.title)), ["First", "Second"])
        XCTAssertEqual(ts.openLoops.map(\.statement), ["q1"])
        XCTAssertEqual(ts.recentChanges.count, 2)
        XCTAssertEqual(ts.openLoops.first?.ideaTitle, "First")
    }

    func testTraceRoundTripsAnIdea() {
        var g = OnDeviceGraph.fold(delta("Idea", "Where it stands.", state: "contested", q: "open?"),
                                   captureId: "c1", into: .empty)
        g = OnDeviceGraph.fold(delta("Idea", "Sharper now.", target: g.ideas[0].id), captureId: "c2", into: g)
        let trace = g.trace(g.ideas[0].id)
        XCTAssertEqual(trace?.idea.state, "contested")
        XCTAssertEqual(trace?.idea.currentFormulation, "Sharper now.")
        XCTAssertEqual(trace?.provenance.count, 2)
        XCTAssertEqual(trace?.idea.openLoops.first?.statement, "open?")
    }

    func testTraceUnknownIdReturnsNil() {
        XCTAssertNil(LocalGraph.empty.trace("local_nope"))
    }

    // MARK: GraphDelta.parse

    func testParsesTargetAndFields() {
        let d = OnDeviceModel.GraphDelta.parse(#"{"target":"local_abc","title":"T","formulation":"F.","state":"established","openQuestion":null}"#)
        XCTAssertEqual(d?.target, "local_abc")
        XCTAssertEqual(d?.state, "established")
        XCTAssertNil(d?.openQuestion)
    }

    func testParseDefaultsMissingTargetToNew() {
        let d = OnDeviceModel.GraphDelta.parse(#"{"title":"T","formulation":"F."}"#)
        XCTAssertEqual(d?.target, "new")
    }

    func testParseNoTitleIsNil() {
        XCTAssertNil(OnDeviceModel.GraphDelta.parse(#"{"target":"new"}"#))
    }

    // MARK: snapshot back-compat

    func testSnapshotWithoutLocalGraphStillDecodes() throws {
        let legacy = #"{"traces":{},"pendingCaptures":[],"pendingEdits":[],"savedAt":751000000}"#.data(using: .utf8)!
        let back = try JSONDecoder().decode(LocalSnapshot.self, from: legacy)
        XCTAssertTrue(back.localGraph.ideas.isEmpty)
    }

    func testSnapshotWithLocalGraphRoundTrips() throws {
        var snap = LocalSnapshot.empty
        snap.localGraph = OnDeviceGraph.fold(delta("A", "F", q: "q?"), captureId: "c1", into: .empty)
        let data = try JSONEncoder().encode(snap)
        let back = try JSONDecoder().decode(LocalSnapshot.self, from: data)
        XCTAssertEqual(back.localGraph, snap.localGraph)
    }
}
