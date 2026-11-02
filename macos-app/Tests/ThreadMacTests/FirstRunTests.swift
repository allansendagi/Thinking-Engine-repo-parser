import XCTest
@testable import ThreadMac

final class FirstRunTests: XCTestCase {
    /// The extension page only works in Chromium browsers; Safari as the default must not win.
    func testExtensionPageOpensInABrowserItRunsIn() {
        let chrome = "com.google.Chrome", brave = "com.brave.Browser", safari = "com.apple.Safari"
        // Default is Safari, Chrome is installed -> Chrome.
        XCTAssertEqual(extensionBrowserToOpen(defaultBrowser: safari, installed: { $0 == chrome }), chrome)
        // Default is already a supported browser -> keep it.
        XCTAssertEqual(extensionBrowserToOpen(defaultBrowser: brave, installed: { _ in true }), brave)
        // Chrome beats the other installed ones when the default doesn't qualify.
        XCTAssertEqual(extensionBrowserToOpen(defaultBrowser: safari, installed: { $0 == brave || $0 == chrome }), chrome)
        // Nothing suitable installed -> nil, so the caller opens the default and the page explains.
        XCTAssertNil(extensionBrowserToOpen(defaultBrowser: safari, installed: { _ in false }))
        XCTAssertNil(extensionBrowserToOpen(defaultBrowser: nil, installed: { _ in false }))
    }
}

/// The welcome asks for exactly one first step -- the fastest route to a first idea.
final class FirstStepTests: XCTestCase {
    func testCursorHistoryComesFirstUntilARecoveryHasStarted() {
        XCTAssertEqual(firstStep(cursorHistory: true, recoveryStarted: false, browserCapturePublic: true), .recoverCursor)
        XCTAssertEqual(firstStep(cursorHistory: true, recoveryStarted: true, browserCapturePublic: true), .connectBrowser)
    }

    func testWithoutCursorTheBrowserIsTheStepOnceTheExtensionIsPublic() {
        XCTAssertEqual(firstStep(cursorHistory: false, recoveryStarted: false, browserCapturePublic: true), .connectBrowser)
        XCTAssertEqual(firstStep(cursorHistory: false, recoveryStarted: false, browserCapturePublic: false), .recoverHistory)
    }
}
