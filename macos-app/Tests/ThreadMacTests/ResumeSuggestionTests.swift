import XCTest
@testable import ThreadMac

final class ResumeSuggestionTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_760_000_000)
    private func daysAgo(_ n: Double) -> Date { now.addingTimeInterval(-n * 86_400) }

    private func cand(
        _ id: String, state: String = "developing", loop: Bool = true, touchedDaysAgo: Double
    ) -> ResumeCandidate {
        ResumeCandidate(
            id: id, title: id.capitalized, state: state, source: "Claude",
            hasOpenLoop: loop, lastTouched: daysAgo(touchedDaysAgo)
        )
    }

    func testPicksTheMostRecentQualifier() {
        let out = pickResumeSuggestion(
            [cand("a", touchedDaysAgo: 20), cand("b", touchedDaysAgo: 6), cand("c", touchedDaysAgo: 12)],
            snoozed: [:], now: now
        )
        XCTAssertEqual(out?.ideaId, "b")
        XCTAssertEqual(out?.daysAgo, 6)
    }

    func testNeedsSomethingUnfinished() {
        // no open loop, not contested -> not a candidate
        XCTAssertNil(pickResumeSuggestion([cand("a", loop: false, touchedDaysAgo: 10)], snoozed: [:], now: now))
        // contested with no loop still qualifies
        XCTAssertNotNil(
            pickResumeSuggestion([cand("a", state: "contested", loop: false, touchedDaysAgo: 10)], snoozed: [:], now: now)
        )
    }

    func testAgeWindow() {
        XCTAssertNil(pickResumeSuggestion([cand("a", touchedDaysAgo: 1)], snoozed: [:], now: now))   // too fresh
        XCTAssertNil(pickResumeSuggestion([cand("a", touchedDaysAgo: 60)], snoozed: [:], now: now))  // abandoned
        XCTAssertNotNil(pickResumeSuggestion([cand("a", touchedDaysAgo: 3)], snoozed: [:], now: now))
        XCTAssertNotNil(pickResumeSuggestion([cand("a", touchedDaysAgo: 45)], snoozed: [:], now: now))
    }

    func testSkipsDormantAndRejected() {
        XCTAssertNil(pickResumeSuggestion([cand("a", state: "dormant", touchedDaysAgo: 10)], snoozed: [:], now: now))
        XCTAssertNil(pickResumeSuggestion([cand("a", state: "rejected", touchedDaysAgo: 10)], snoozed: [:], now: now))
    }

    func testSnoozeSuppressesUntilTouchedAgain() {
        let c = cand("a", touchedDaysAgo: 10)
        // snoozed after the last activity -> suppressed
        XCTAssertNil(pickResumeSuggestion([c], snoozed: ["a": daysAgo(2)], now: now))
        // snoozed before the last activity (idea moved since) -> resurfaces
        XCTAssertNotNil(pickResumeSuggestion([c], snoozed: ["a": daysAgo(20)], now: now))
    }

    func testNoQualifiersMeansNoNudge() {
        XCTAssertNil(pickResumeSuggestion([], snoozed: [:], now: now))
    }
}
