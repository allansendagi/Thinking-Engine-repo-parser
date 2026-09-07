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
}

private extension Array where Element: Hashable {
    func uniqued() -> [Element] {
        var seen = Set<Element>()
        return filter { seen.insert($0).inserted }
    }
}
