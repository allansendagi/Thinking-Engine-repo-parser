import XCTest
@testable import ThreadMac

final class AmbientNudgeTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_760_000_000)
    private let gap: TimeInterval = 45 * 60
    private let cooldown: TimeInterval = 4 * 3600

    private func fire(active: TimeInterval?, notified: TimeInterval?) -> Bool {
        ambientNudgeShouldFire(
            now: now,
            lastThinkingActive: active.map { now.addingTimeInterval(-$0) },
            lastNotifiedAt: notified.map { now.addingTimeInterval(-$0) },
            returnGap: gap, cooldown: cooldown
        )
    }

    func testFirstRunFires() {
        XCTAssertTrue(fire(active: nil, notified: nil))
    }

    func testShortHopDoesNotFire() {
        // Away from a thinking surface for only 5 minutes — you didn't "leave" it.
        XCTAssertFalse(fire(active: 5 * 60, notified: nil))
    }

    func testRealReturnFires() {
        XCTAssertTrue(fire(active: 90 * 60, notified: nil))
    }

    func testCooldownSuppressesASecondNotification() {
        // Genuine return, but we notified 30 minutes ago.
        XCTAssertFalse(fire(active: 90 * 60, notified: 30 * 60))
    }

    func testFiresAgainAfterCooldownElapses() {
        XCTAssertTrue(fire(active: 90 * 60, notified: 5 * 3600))
    }

    func testExactlyAtBoundaries() {
        XCTAssertTrue(fire(active: gap, notified: cooldown))          // >= on both
        XCTAssertFalse(fire(active: gap - 1, notified: nil))
        XCTAssertFalse(fire(active: 90 * 60, notified: cooldown - 1))
    }
}
