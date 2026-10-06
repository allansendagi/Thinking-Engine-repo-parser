import XCTest
@testable import ThreadMac

final class CaptureHealthNoticeTests: XCTestCase {
    private func health(_ healthy: Bool, unresolved: Int = 0, degraded: [String] = []) -> CaptureHealth {
        CaptureHealth(
            healthy: healthy,
            unresolvedConversations: unresolved,
            sensors: (degraded + ["browser_extension"]).uniqued().map {
                CaptureHealth.Sensor(sensor: $0, observations: 5, failed: degraded.contains($0) ? 4 : 0, degraded: degraded.contains($0))
            }
        )
    }

    func testHealthyProducesNoNotice() {
        XCTAssertNil(makeCaptureHealthNotice(health(true)))
        XCTAssertNil(makeCaptureHealthNotice(nil))
    }

    func testDegradedNonBrowserSensorIsNamedPlainlyWithNoBusywork() throws {
        let n = try XCTUnwrap(makeCaptureHealthNotice(health(false, degraded: ["native_accessibility"])))
        XCTAssertEqual(n.title, "Thread isn't reliably reading a Mac app right now")
        XCTAssertNil(n.detail, "no detail when there's nothing the user can do")
    }

    func testDegradedBrowserSensorGetsAnActionableDetail() throws {
        let n = try XCTUnwrap(makeCaptureHealthNotice(health(false, degraded: ["browser_extension"])))
        XCTAssertEqual(n.title, "Thread isn't reliably reading your browser right now")
        XCTAssertTrue(n.detail?.contains("Thread extension") ?? false)
    }

    func testUnresolvedThinkingIsTheHonestOneLinerNoMachinerySpeak() throws {
        let n = try XCTUnwrap(makeCaptureHealthNotice(health(false, unresolved: 3)))
        XCTAssertEqual(n.title, "Some recent thinking couldn't be confidently connected")
        XCTAssertNil(n.detail)
    }

    func testADegradedSensorTakesPriorityOverUnresolvedCount() throws {
        let n = try XCTUnwrap(makeCaptureHealthNotice(health(false, unresolved: 2, degraded: ["browser_extension"])))
        XCTAssertEqual(n.title, "Thread isn't reliably reading your browser right now")
    }

    func testCapturesWaitingForTheAIComeFirstAndReassure() throws {
        var h = health(false, unresolved: 2, degraded: ["browser_extension"])
        h.pendingExtraction = .init(count: 4, lastError: "400 Your credit balance is too low")
        let n = try XCTUnwrap(makeCaptureHealthNotice(h))
        XCTAssertEqual(n.title, "4 captured messages waiting to become ideas")
        XCTAssertTrue(n.detail?.contains("Everything is saved") ?? false)
        XCTAssertFalse(n.detail?.contains("credit") ?? true, "provider billing details aren't the user's concern")
    }

    func testDecodesAServerThatReportsWaitingCaptures() throws {
        let json = #"{"windowDays":7,"healthy":false,"sensors":[],"unresolvedConversations":0,"pendingExtraction":{"count":2,"lastError":"x","oldestQueuedAt":"2026-10-06T09:00:00Z"}}"#
        let h = try JSONDecoder().decode(CaptureHealth.self, from: Data(json.utf8))
        XCTAssertEqual(h.pendingExtraction?.count, 2)
    }
}

private extension Array where Element: Hashable {
    func uniqued() -> [Element] {
        var seen = Set<Element>()
        return filter { seen.insert($0).inserted }
    }
}
