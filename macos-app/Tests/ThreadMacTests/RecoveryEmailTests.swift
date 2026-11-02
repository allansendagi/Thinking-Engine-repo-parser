import XCTest
@testable import ThreadMac

/// Recovery is optional; choosing it on an account with no email asks for one first (it sets up
/// the account), and the chosen recovery waits for it. An account that already has an email is
/// never asked.
@MainActor
final class RecoveryEmailTests: XCTestCase {
    private var localDir: URL!
    private var credDir: URL!

    override func setUpWithError() throws {
        localDir = FileManager.default.temporaryDirectory.appendingPathComponent("thread-recmail-l-\(UUID().uuidString)", isDirectory: true)
        credDir = FileManager.default.temporaryDirectory.appendingPathComponent("thread-recmail-c-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: localDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: credDir, withIntermediateDirectories: true)
        LocalStore.directoryOverride = localDir
        CredentialStore.directoryOverride = credDir
        UserDefaults.standard.removeObject(forKey: "thread.lastKnownEmail")
        UserDefaults.standard.removeObject(forKey: "thread.recoveryStarted")
    }

    override func tearDownWithError() throws {
        LocalStore.directoryOverride = nil
        CredentialStore.directoryOverride = nil
        UserDefaults.standard.removeObject(forKey: "thread.lastKnownEmail")
        UserDefaults.standard.removeObject(forKey: "thread.recoveryStarted")
        try? FileManager.default.removeItem(at: localDir)
        try? FileManager.default.removeItem(at: credDir)
    }

    func testChoosingRecoveryWithoutAnEmailAsksForItAndHoldsTheChoice() {
        CredentialStore.save(userId: "user_recmail000000000000000000", token: "t")
        let app = AppState()
        XCTAssertFalse(app.accountHasEmail)

        app.runCursorBackfill()
        XCTAssertEqual(app.backfill, .needsEmail(.cursor(.recent)))
        XCTAssertTrue(app.showsBackfillSheet)
        XCTAssertFalse(app.recoveryStarted, "nothing is sent before the account has an email")

        app.recoverViaBrowser(.chatgpt)
        XCTAssertEqual(app.backfill, .needsEmail(.browser(.chatgpt)))
    }

    func testAnAccountWithAnEmailIsNeverAsked() {
        CredentialStore.save(userId: "user_recmail000000000000000001", token: "t", email: "a@b.co")
        let app = AppState()
        XCTAssertTrue(app.accountHasEmail)
        XCTAssertTrue(app.readyToRecover(.cursor(.recent)))
        if case .needsEmail = app.backfill { XCTFail("asked for an email it already has") }
    }
}
