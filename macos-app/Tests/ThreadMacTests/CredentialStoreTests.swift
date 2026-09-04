import XCTest
@testable import ThreadMac

/// The credential store is what stands between a routine restart and "the app made a new empty
/// account over my real one". These lock in the distinction that matters: a file we can't read
/// is *not* the same as no file.
final class CredentialStoreTests: XCTestCase {
    private var scratch: URL!

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("thread-credstore-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        CredentialStore.directoryOverride = scratch
        UserDefaults.standard.removeObject(forKey: "thread.lastKnownEmail")
        UserDefaults.standard.removeObject(forKey: "thread.deliberateSignOut")
    }

    override func tearDownWithError() throws {
        CredentialStore.directoryOverride = nil
        UserDefaults.standard.removeObject(forKey: "thread.lastKnownEmail")
        UserDefaults.standard.removeObject(forKey: "thread.deliberateSignOut")
        try? FileManager.default.removeItem(at: scratch)
    }

    private var primary: URL { scratch.appendingPathComponent("credential.json") }
    private var backup: URL { scratch.appendingPathComponent("credential.json.bak") }

    func testAbsentWhenNothingOnDisk() {
        guard case .absent = CredentialStore.load() else { return XCTFail("expected .absent") }
    }

    func testSaveThenLoadRoundTripsIncludingEmail() {
        CredentialStore.save(userId: "user_aaaaaaaaaaaaaaaaaaaaaaaa", token: "tok", email: "a@b.com")
        guard case .ok(let c) = CredentialStore.load() else { return XCTFail("expected .ok") }
        XCTAssertEqual(c.userId, "user_aaaaaaaaaaaaaaaaaaaaaaaa")
        XCTAssertEqual(c.token, "tok")
        XCTAssertEqual(c.email, "a@b.com")
        XCTAssertEqual(CredentialStore.lastKnownEmail, "a@b.com")
        XCTAssertTrue(FileManager.default.fileExists(atPath: backup.path), "a .bak must be written alongside")
    }

    func testCorruptPrimaryFallsBackToBackupAndHealsIt() throws {
        CredentialStore.save(userId: "user_bbbbbbbbbbbbbbbbbbbbbbbb", token: "tok2", email: "b@c.com")
        try Data("{ this is not json".utf8).write(to: primary)

        guard case .ok(let c) = CredentialStore.load() else { return XCTFail("expected recovery from .bak") }
        XCTAssertEqual(c.userId, "user_bbbbbbbbbbbbbbbbbbbbbbbb")
        XCTAssertEqual(c.email, "b@c.com")

        // The primary should have been rewritten from the backup.
        let healed = try JSONDecoder().decode(CredentialStore.Credential.self, from: Data(contentsOf: primary))
        XCTAssertEqual(healed.userId, "user_bbbbbbbbbbbbbbbbbbbbbbbb")
    }

    func testUnreadableWhenPrimaryCorruptAndNoBackup() throws {
        try Data("garbage".utf8).write(to: primary)
        guard case .unreadable = CredentialStore.load() else {
            return XCTFail("a present-but-unreadable file must be .unreadable, never .absent")
        }
    }

    func testClearRemovesPrimaryAndBackupAndEmailMirrorAndFlagsSignOut() {
        CredentialStore.save(userId: "user_cccccccccccccccccccccccc", token: "t", email: "c@d.com")
        XCTAssertFalse(CredentialStore.deliberatelySignedOut)
        CredentialStore.clear()
        guard case .absent = CredentialStore.load() else { return XCTFail("expected .absent after clear") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: backup.path))
        XCTAssertNil(CredentialStore.lastKnownEmail)
        XCTAssertTrue(CredentialStore.deliberatelySignedOut)

        // A fresh pair clears the sign-out flag again.
        CredentialStore.save(userId: "user_cccccccccccccccccccccccc", token: "t2")
        XCTAssertFalse(CredentialStore.deliberatelySignedOut)
    }

    func testLegacyCredentialWithoutEmailStillDecodes() throws {
        try Data(#"{"userId":"user_dddddddddddddddddddddddd","token":"legacy"}"#.utf8).write(to: primary)
        guard case .ok(let c) = CredentialStore.load() else { return XCTFail("expected .ok") }
        XCTAssertEqual(c.userId, "user_dddddddddddddddddddddddd")
        XCTAssertNil(c.email)
    }

    func testResaveWithoutEmailKeepsThePreviouslyStoredEmail() {
        CredentialStore.save(userId: "user_eeeeeeeeeeeeeeeeeeeeeeee", token: "t1", email: "keep@me.com")
        CredentialStore.save(userId: "user_eeeeeeeeeeeeeeeeeeeeeeee", token: "t2") // token refresh, no email
        XCTAssertEqual(CredentialStore.credential?.email, "keep@me.com")
    }
}
