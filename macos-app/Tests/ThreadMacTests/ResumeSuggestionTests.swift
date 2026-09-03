import XCTest
@testable import ThreadMac

/// The return nudge is held to "never wrong": it stays silent unless one idea is clearly the
/// one you're coming back to. These tests pin the scoring rule's edges.
final class ResumeSuggestionTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_760_000_000)
    private func daysAgo(_ n: Double) -> Date { now.addingTimeInterval(-n * 86_400) }

    private func cand(
        _ id: String, state: String = "developing", loop: Bool = true,
        contradiction: Bool = false, touchedDaysAgo: Double
    ) -> ResumeCandidate {
        ResumeCandidate(
            id: id, title: id.capitalized, state: state, source: "Claude",
            hasOpenLoop: loop, isContradiction: contradiction, lastTouched: daysAgo(touchedDaysAgo)
        )
    }
    private func pick(_ cs: [ResumeCandidate], snoozed: [String: Date] = [:], history: [String: ResumeShown] = [:]) -> ResumeSuggestion? {
        pickResumeSuggestion(cs, snoozed: snoozed, history: history, now: now)
    }

    // MARK: the sweet spot

    func testFiresForAnOpenQuestionInTheSweetSpot() {
        let out = pick([cand("a", touchedDaysAgo: 7)])
        XCTAssertEqual(out?.ideaId, "a")
        XCTAssertEqual(out?.daysAgo, 7)
    }

    func testFiresForAContradiction() {
        XCTAssertNotNil(pick([cand("a", loop: false, contradiction: true, touchedDaysAgo: 9)]))
        XCTAssertNotNil(pick([cand("a", state: "contested", loop: false, touchedDaysAgo: 9)]))
    }

    // MARK: recency

    func testTooFreshStaysSilent() {
        XCTAssertNil(pick([cand("a", touchedDaysAgo: 1)]))     // still on it
        XCTAssertNil(pick([cand("a", touchedDaysAgo: 0.5)]))
    }

    func testAbandonedStaysSilent() {
        XCTAssertNil(pick([cand("a", touchedDaysAgo: 55)]))
        // A month-old plain open question is exactly the wrong-nudge case — stay quiet.
        XCTAssertNil(pick([cand("a", touchedDaysAgo: 32)]))
    }

    func testContradictionCarriesFurtherThanAnOpenQuestion() {
        // Same age where an open question has already decayed below the floor.
        XCTAssertNil(pick([cand("q", touchedDaysAgo: 30)]))
        XCTAssertNotNil(pick([cand("c", contradiction: true, touchedDaysAgo: 30)]))
    }

    // MARK: nothing unfinished

    func testNothingUnfinishedIsNeverACandidate() {
        XCTAssertNil(pick([cand("a", loop: false, touchedDaysAgo: 7)]))
    }

    func testDormantAndRejectedAreSkipped() {
        XCTAssertNil(pick([cand("a", state: "dormant", touchedDaysAgo: 7)]))
        XCTAssertNil(pick([cand("a", state: "rejected", touchedDaysAgo: 7)]))
    }

    // MARK: ambiguity gate

    func testTwoNearIdenticalCandidatesStaySilent() {
        // Same strength, ~same age → we don't know which one you mean.
        XCTAssertNil(pick([cand("a", touchedDaysAgo: 7), cand("b", touchedDaysAgo: 8)]))
    }

    func testAClearlyMoreRecentCandidateStillWins() {
        let out = pick([cand("a", touchedDaysAgo: 7), cand("b", touchedDaysAgo: 20)])
        XCTAssertEqual(out?.ideaId, "a")
    }

    func testAStrongerSignalBreaksAThreeWayTie() {
        let out = pick([
            cand("q1", touchedDaysAgo: 7),
            cand("q2", touchedDaysAgo: 8),
            cand("c", contradiction: true, touchedDaysAgo: 9),
        ])
        XCTAssertEqual(out?.ideaId, "c")   // contradiction outscores the two open questions
    }

    // MARK: fatigue

    func testAnOpenQuestionStopsBeingOfferedAfterACoupleOfUnactedShows() {
        let c = cand("a", touchedDaysAgo: 7)
        let act = daysAgo(7)
        XCTAssertNotNil(pick([c], history: ["a": ResumeShown(count: 0, sinceActivity: act)]))
        XCTAssertNotNil(pick([c], history: ["a": ResumeShown(count: 1, sinceActivity: act)]))
        XCTAssertNil(pick([c], history: ["a": ResumeShown(count: 2, sinceActivity: act)]))
    }

    func testAContradictionGetsOneMoreShowThanAnOpenQuestion() {
        let c = cand("a", loop: false, contradiction: true, touchedDaysAgo: 9)
        let act = daysAgo(9)
        XCTAssertNotNil(pick([c], history: ["a": ResumeShown(count: 2, sinceActivity: act)]))
        XCTAssertNil(pick([c], history: ["a": ResumeShown(count: 3, sinceActivity: act)]))
    }

    func testFatigueResetsWhenTheIdeaMovesAgain() {
        let c = cand("a", touchedDaysAgo: 7)                       // last activity: 7 days ago
        // History was recorded against activity 20 days ago; the idea has moved since → count ignored.
        XCTAssertNotNil(pick([c], history: ["a": ResumeShown(count: 5, sinceActivity: daysAgo(20))]))
    }

    // MARK: snooze

    func testSnoozeSuppressesUntilTouchedAgain() {
        let c = cand("a", touchedDaysAgo: 7)
        XCTAssertNil(pick([c], snoozed: ["a": daysAgo(2)]))       // snoozed after last activity
        XCTAssertNotNil(pick([c], snoozed: ["a": daysAgo(20)]))   // idea moved since the snooze
    }

    func testNothingToSuggest() {
        XCTAssertNil(pick([]))
    }
}
