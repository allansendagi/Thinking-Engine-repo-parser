import XCTest
@testable import ThreadMac

final class LocalStoreTests: XCTestCase {

    private func idea(_ id: String, title: String, formulation: String, state: String = "developing") -> IdeaSummary {
        IdeaSummary(
            id: id, title: title, state: state, currentFormulation: formulation, latestSource: "claude"
        )
    }

    // MARK: localSearch

    func testEmptyQueryReturnsNothing() {
        let ideas = [idea("a", title: "Computable Authority", formulation: "governance you can run")]
        XCTAssertTrue(localSearch("", in: ideas).isEmpty)
        XCTAssertTrue(localSearch("   ", in: ideas).isEmpty)
    }

    func testMatchesOnTitleAndBodyAndRanksTitleHigher() {
        let ideas = [
            idea("a", title: "Computable Authority", formulation: "a governance protocol"),
            idea("b", title: "Sync design", formulation: "the authority to write comes from the lease"),
        ]
        let hits = localSearch("authority", in: ideas)
        XCTAssertEqual(hits.map(\.id), ["a", "b"])          // title hit outranks body hit
        XCTAssertGreaterThan(hits[0].score, hits[1].score)
    }

    func testAllTermsMustMatch() {
        let ideas = [
            idea("a", title: "Computable Authority", formulation: "governance protocol"),
            idea("b", title: "Computable cache", formulation: "local first reads"),
        ]
        XCTAssertEqual(localSearch("computable authority", in: ideas).map(\.id), ["a"])
        XCTAssertTrue(localSearch("computable nonexistentword", in: ideas).isEmpty)
    }

    func testWholeQueryTitlePrefixWins() {
        let ideas = [
            idea("a", title: "Local first", formulation: "everything works offline on the mac first"),
            idea("b", title: "First principles of local caching", formulation: "local first"),
        ]
        XCTAssertEqual(localSearch("local first", in: ideas).first?.id, "a")
    }

    func testResultShapeMirrorsServer() {
        let ideas = [idea("a", title: "T", formulation: "body has the term xyzzy", state: "contested")]
        let hit = localSearch("xyzzy", in: ideas).first
        XCTAssertEqual(hit?.id, "a")
        XCTAssertEqual(hit?.state, "contested")
        XCTAssertEqual(hit?.currentFormulation, "body has the term xyzzy")
    }

    // MARK: snapshot round-trip

    func testSnapshotEncodesAndDecodes() throws {
        let snap = LocalSnapshot(
            thinkingState: nil,
            traces: [:],
            pendingCaptures: [
                PendingCapture(
                    id: "p1", text: "some thinking",
                    draft: LocalIdeaDraft(title: "T", formulation: "F", state: "developing", openQuestion: "Q?"),
                    createdAt: Date(timeIntervalSince1970: 1_700_000_100), status: .queued
                )
            ],
            pendingEdits: [PendingEdit.rename("i1", "renamed")],
            savedAt: Date(timeIntervalSince1970: 1_700_000_000)
        )
        let data = try JSONEncoder().encode(snap)
        let back = try JSONDecoder().decode(LocalSnapshot.self, from: data)
        XCTAssertEqual(back.savedAt, snap.savedAt)
        XCTAssertTrue(back.traces.isEmpty)
        XCTAssertNil(back.thinkingState)
        XCTAssertEqual(back.pendingCaptures, snap.pendingCaptures)
        XCTAssertEqual(back.pendingEdits, snap.pendingEdits)
    }

    /// A snapshot written before `pendingCaptures` / `pendingEdits` existed must still decode.
    func testSnapshotBackCompatWithoutNewFields() throws {
        let legacy = #"{"traces":{},"savedAt":751000000}"#.data(using: .utf8)!
        let back = try JSONDecoder().decode(LocalSnapshot.self, from: legacy)
        XCTAssertTrue(back.pendingCaptures.isEmpty)
        XCTAssertTrue(back.pendingEdits.isEmpty)
        XCTAssertTrue(back.traces.isEmpty)
    }

    // MARK: LocalIdeaDraft.parse

    func testParsesCleanJSON() {
        let d = LocalIdeaDraft.parse(#"{"title":"Computable authority","formulation":"Authority must be independently verifiable.","state":"contested","openQuestion":"Who verifies?"}"#)
        XCTAssertEqual(d?.title, "Computable authority")
        XCTAssertEqual(d?.state, "contested")
        XCTAssertEqual(d?.openQuestion, "Who verifies?")
    }

    func testParsesJSONWrappedInProse() {
        let d = LocalIdeaDraft.parse("Here you go:\n{\"title\": \"Local first\", \"formulation\": \"Reads work offline.\", \"state\": \"developing\", \"openQuestion\": null}\nHope that helps.")
        XCTAssertEqual(d?.title, "Local first")
        XCTAssertNil(d?.openQuestion)
    }

    func testUnknownStateFallsBackToDeveloping() {
        let d = LocalIdeaDraft.parse(#"{"title":"X","formulation":"Y","state":"brainstorming"}"#)
        XCTAssertEqual(d?.state, "developing")
    }

    func testNoIdeaReturnsNil() {
        XCTAssertNil(LocalIdeaDraft.parse(#"{"title": null}"#))
        XCTAssertNil(LocalIdeaDraft.parse("no json here at all"))
        XCTAssertNil(LocalIdeaDraft.parse(#"{"title": "   "}"#))
    }

    func testFormulationDefaultsToTitleWhenMissing() {
        let d = LocalIdeaDraft.parse(#"{"title":"Just a title","state":"developing"}"#)
        XCTAssertEqual(d?.formulation, "Just a title")
    }
}
