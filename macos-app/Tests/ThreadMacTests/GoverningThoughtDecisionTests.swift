import XCTest
@testable import ThreadMac

/// The deterministic half of OnDeviceModel.governingThought -- parsing/validation and the
/// structural-agreement evaluator. Pure functions, no live model call, so unlike
/// GoverningThoughtBenchmark.swift this runs everywhere, including CI.
final class GoverningThoughtDecisionTests: XCTestCase {

    // MARK: - GoverningThoughtDecision.parse

    func testParsesACleanCoherentResponse() {
        let raw = #"{"coherent": true, "governingThought": "Authority must be executable and verifiable.", "groupType": "reasons", "supportingIdeaIds": [1, 3]}"#
        let d = GoverningThoughtDecision.parse(raw, candidateCount: 4)
        XCTAssertEqual(d?.coherent, true)
        XCTAssertEqual(d?.statement, "Authority must be executable and verifiable.")
        XCTAssertEqual(d?.kind, "reasons")
        XCTAssertEqual(d?.supportingIndexes, [1, 3])
    }

    func testParsesACleanFalseResponseWithEmptyContent() {
        let raw = #"{"coherent": false, "governingThought": null, "groupType": null, "supportingIdeaIds": null}"#
        let d = GoverningThoughtDecision.parse(raw, candidateCount: 2)
        XCTAssertEqual(d?.coherent, false)
        XCTAssertEqual(d?.supportingIndexes, [])
    }

    func testFalseWithStrayContentIsIgnoredNotValidated() {
        // A model sometimes writes real content even while saying coherent:false (observed on
        // the real benchmark). That content must never leak through -- a false answer is always
        // the empty sentinel, regardless of what else the model wrote alongside it.
        let raw = #"{"coherent": false, "governingThought": "some hallucinated synthesis", "groupType": "reasons", "supportingIdeaIds": [1]}"#
        let d = GoverningThoughtDecision.parse(raw, candidateCount: 2)
        XCTAssertEqual(d?.coherent, false)
        XCTAssertEqual(d?.statement, "")
        XCTAssertEqual(d?.supportingIndexes, [])
    }

    func testTolerantOfProseWrappedAroundTheJson() {
        let raw = "```json\n{\"coherent\": true, \"governingThought\": \"x.\", \"groupType\": \"reasons\", \"supportingIdeaIds\": [1]}\n```"
        XCTAssertNotNil(GoverningThoughtDecision.parse(raw, candidateCount: 1))
    }

    func testRejectsMalformedJson() {
        XCTAssertNil(GoverningThoughtDecision.parse("not json at all", candidateCount: 2))
        XCTAssertNil(GoverningThoughtDecision.parse("", candidateCount: 2))
    }

    func testRejectsCoherentTrueWithMissingRequiredFields() {
        XCTAssertNil(GoverningThoughtDecision.parse(#"{"coherent": true, "groupType": "reasons", "supportingIdeaIds": [1]}"#, candidateCount: 2))
        XCTAssertNil(GoverningThoughtDecision.parse(#"{"coherent": true, "governingThought": "x.", "supportingIdeaIds": [1]}"#, candidateCount: 2))
        XCTAssertNil(GoverningThoughtDecision.parse(#"{"coherent": true, "governingThought": "x.", "groupType": "reasons", "supportingIdeaIds": []}"#, candidateCount: 2))
    }

    func testOutOfRangeIndexesAreDroppedNotRejectedWholesale() {
        // 99 is out of range for a 2-candidate set; the well-formed index (1) still stands.
        let d = GoverningThoughtDecision.parse(#"{"coherent": true, "governingThought": "x.", "groupType": "reasons", "supportingIdeaIds": [1, 99]}"#, candidateCount: 2)
        XCTAssertEqual(d?.supportingIndexes, [1])
    }

    func testAllIndexesOutOfRangeIsRejected() {
        XCTAssertNil(GoverningThoughtDecision.parse(#"{"coherent": true, "governingThought": "x.", "groupType": "reasons", "supportingIdeaIds": [99]}"#, candidateCount: 2))
    }

    func testDuplicateIndexesAreDeduplicated() {
        let d = GoverningThoughtDecision.parse(#"{"coherent": true, "governingThought": "x.", "groupType": "reasons", "supportingIdeaIds": [1, 1, 2]}"#, candidateCount: 2)
        XCTAssertEqual(d?.supportingIndexes, [1, 2])
    }

    func testRejectsARefusalShapedStatement() {
        XCTAssertNil(GoverningThoughtDecision.parse(#"{"coherent": true, "governingThought": "I cannot provide that.", "groupType": "reasons", "supportingIdeaIds": [1]}"#, candidateCount: 2))
    }

    func testRejectsAGroupTypeThatIsActuallyASentence() {
        let longKind = "the reasons that this idea genuinely supports the current thought in question"
        XCTAssertNil(GoverningThoughtDecision.parse(#"{"coherent": true, "governingThought": "x.", "groupType": "\#(longKind)", "supportingIdeaIds": [1]}"#, candidateCount: 2))
    }

    func testRejectsAnOverlongStatement() {
        let longStatement = String(repeating: "x", count: 241)
        XCTAssertNil(GoverningThoughtDecision.parse(#"{"coherent": true, "governingThought": "\#(longStatement)", "groupType": "reasons", "supportingIdeaIds": [1]}"#, candidateCount: 2))
    }

    // MARK: - OnDeviceModel.structuralAgreement

    private func decision(_ coherent: Bool, _ indexes: [Int] = [], statement: String = "Authority must be executable.", kind: String = "reasons") -> GoverningThoughtDecision {
        GoverningThoughtDecision(coherent: coherent, statement: statement, kind: kind, supportingIndexes: indexes)
    }

    private let twoCandidates = [
        GoverningThoughtCandidate(id: "idea_a", formulation: "a"),
        GoverningThoughtCandidate(id: "idea_b", formulation: "b"),
    ]

    func testUnanimousCoherentSameIndexesIsFound() {
        let runs = [decision(true, [1, 2]), decision(true, [1, 2]), decision(true, [1, 2])]
        guard case .found(let result) = OnDeviceModel.structuralAgreement(runs, candidates: twoCandidates) else {
            return XCTFail("expected .found")
        }
        XCTAssertEqual(Set(result.memberIds), ["idea_a", "idea_b"])
    }

    func testWordingDifferencesAcrossRunsDontBreakAgreement() {
        // Same structural decision, different governing-thought sentence text -- the benchmark's
        // whole point: don't require sentence-level identity, only the structural one.
        let runs = [
            decision(true, [1], statement: "Authority must be machine-executable and verifiable."),
            decision(true, [1], statement: "Institutional authority needs independent verification."),
            decision(true, [1], statement: "Executable authority requires trust mechanisms."),
        ]
        guard case .found = OnDeviceModel.structuralAgreement(runs, candidates: twoCandidates) else {
            return XCTFail("expected .found despite differing wording")
        }
    }

    func testUnanimousFalseIsConfidentlyNoneNotFound() {
        let runs = [decision(false), decision(false), decision(false)]
        XCTAssertEqual(OnDeviceModel.structuralAgreement(runs, candidates: twoCandidates), .confidentlyNone)
    }

    func testSplitCoherenceIsUncertain() {
        let runs = [decision(true, [1]), decision(false), decision(true, [1])]
        XCTAssertEqual(OnDeviceModel.structuralAgreement(runs, candidates: twoCandidates), .uncertain)
    }

    func testSameCoherenceDifferentSelectedIndexesIsUncertain() {
        let runs = [decision(true, [1]), decision(true, [2]), decision(true, [1])]
        XCTAssertEqual(OnDeviceModel.structuralAgreement(runs, candidates: twoCandidates), .uncertain)
    }

    func testIndexSetOrderDoesntMatterForAgreement() {
        let runs = [decision(true, [2, 1]), decision(true, [1, 2]), decision(true, [1, 2])]
        guard case .found = OnDeviceModel.structuralAgreement(runs, candidates: twoCandidates) else {
            return XCTFail("expected .found -- {1,2} and {2,1} are the same set")
        }
    }

    func testFewerThanThreeRunsIsUncertain() {
        XCTAssertEqual(OnDeviceModel.structuralAgreement([decision(true, [1]), decision(true, [1])], candidates: twoCandidates), .uncertain)
        XCTAssertEqual(OnDeviceModel.structuralAgreement([], candidates: twoCandidates), .uncertain)
    }

    func testNeverReturnsUnavailable() {
        // .unavailable means "never attempted" -- structuralAgreement only runs once calls
        // actually happened, so it must never produce that case itself.
        let allCases: [[GoverningThoughtDecision]] = [
            [decision(true, [1]), decision(true, [1]), decision(true, [1])],
            [decision(false), decision(false), decision(false)],
            [decision(true, [1]), decision(false), decision(true, [1])],
        ]
        for runs in allCases {
            XCTAssertNotEqual(OnDeviceModel.structuralAgreement(runs, candidates: twoCandidates), .unavailable)
        }
    }
}
