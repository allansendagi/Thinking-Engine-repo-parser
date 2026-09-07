import XCTest
@testable import ThreadMac

final class WelcomeGateTests: XCTestCase {
    private func show(
        isPaired: Bool = true,
        hasReconnect: Bool = false,
        welcomeDismissed: Bool = false,
        everConnectedBrowser: Bool = false,
        ideaCount: Int = 0,
        pendingCaptureCount: Int = 0
    ) -> Bool {
        shouldShowWelcome(
            isPaired: isPaired, hasReconnect: hasReconnect, welcomeDismissed: welcomeDismissed,
            everConnectedBrowser: everConnectedBrowser, ideaCount: ideaCount, pendingCaptureCount: pendingCaptureCount
        )
    }

    func testFreshPairedAccountSeesTheWelcome() {
        XCTAssertTrue(show())
    }

    func testNotShownBeforeTheAccountExists() {
        // RootView handles `!isPaired` itself (WelcomeView also covers that branch); the gate is
        // only about the paired-but-fresh case.
        XCTAssertFalse(show(isPaired: false))
    }

    func testReconnectFlowWins() {
        XCTAssertFalse(show(hasReconnect: true))
    }

    func testDismissedStaysDismissed() {
        XCTAssertFalse(show(welcomeDismissed: true))
    }

    func testAnEstablishedMacNeverFlashesTheFirstRunScreenOnColdLaunch() {
        // thinkingState nil before the first fetch -> ideaCount reads 0. A Mac that has ever had
        // a browser paired must not be treated as fresh.
        XCTAssertFalse(show(everConnectedBrowser: true, ideaCount: 0))
    }

    func testAnyCapturedThinkingClearsIt() {
        XCTAssertFalse(show(ideaCount: 1))
        XCTAssertFalse(show(pendingCaptureCount: 1))
    }
}
