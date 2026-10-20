import XCTest
@testable import ThreadMac

final class ShareInboxTests: XCTestCase {
    private var dir: URL!

    override func setUp() {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("inbox-\(UUID().uuidString)")
        ShareInbox.directoryOverride = dir
    }
    override func tearDown() {
        ShareInbox.directoryOverride = nil
        try? FileManager.default.removeItem(at: dir)
    }

    func testWhatTheExtensionWritesTheAppReadsInOrder() {
        XCTAssertTrue(ShareInbox.write(text: "  Second thought about pricing models  ", now: Date(timeIntervalSince1970: 200)))
        XCTAssertTrue(ShareInbox.write(text: "First thought about authority boundaries", from: "Safari", now: Date(timeIntervalSince1970: 100)))
        let waiting = ShareInbox.pending()
        XCTAssertEqual(waiting.map(\.item.text), ["First thought about authority boundaries", "Second thought about pricing models"], "oldest first, trimmed")
        XCTAssertEqual(waiting.first?.item.from, "Safari")
    }

    func testTooShortIsRefusedAndNothingIsWritten() {
        XCTAssertFalse(ShareInbox.write(text: "hello there"))
        XCTAssertFalse(ShareInbox.write(text: "   \n  "))
        XCTAssertEqual(ShareInbox.pending().count, 0)
    }

    /// A share made before sign-in (the app can't capture yet) must wait, not be lost.
    func testItemsAreRemovedOnlyWhenTheAppTakesThem() {
        ShareInbox.write(text: "one two three four", now: Date(timeIntervalSince1970: 1))
        ShareInbox.write(text: "five six seven eight", now: Date(timeIntervalSince1970: 2))
        XCTAssertEqual(ShareInbox.drain(capture: { _ in false }), 0)
        XCTAssertEqual(ShareInbox.pending().count, 2, "nothing taken, nothing removed")
        var got: [String] = []
        XCTAssertEqual(ShareInbox.drain(capture: { got.append($0); return $0.hasPrefix("one") }), 1)
        XCTAssertEqual(got, ["one two three four", "five six seven eight"])
        XCTAssertEqual(ShareInbox.pending().map(\.item.text), ["five six seven eight"], "only the taken one is gone")
    }

    func testJunkInTheInboxIsIgnoredAndLeftAlone() throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: dir.appendingPathComponent("junk.json"))
        try Data("x".utf8).write(to: dir.appendingPathComponent("note.txt"))
        ShareInbox.write(text: "a real shared thought here")
        XCTAssertEqual(ShareInbox.drain(capture: { _ in true }), 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("junk.json").path))
    }

    func testUnreachableFolderFailsQuietly() {
        ShareInbox.directoryOverride = URL(fileURLWithPath: "/dev/null/nope")
        XCTAssertFalse(ShareInbox.write(text: "one two three four"))
        XCTAssertEqual(ShareInbox.drain(capture: { _ in true }), 0)
    }
}

@MainActor
final class ShareInboxWatcherTests: XCTestCase {
    /// The real watcher, on a real folder: something already waiting is taken at start, and something
    /// dropped in afterwards (what the extension does while the app is running) is taken without a restart.
    func testWatcherTakesWhatIsWaitingAndWhatArrivesLater() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("watch-\(UUID().uuidString)")
        ShareInbox.directoryOverride = dir
        defer { ShareInbox.directoryOverride = nil; try? FileManager.default.removeItem(at: dir) }

        ShareInbox.write(text: "shared while the app was closed")
        var got: [String] = []
        let watcher = ShareInboxWatcher { got.append($0); return true }
        watcher.start()
        XCTAssertEqual(got, ["shared while the app was closed"], "taken at launch")

        ShareInbox.write(text: "shared while the app is running")
        for _ in 0..<40 where got.count < 2 { try await Task.sleep(nanoseconds: 100_000_000) }
        XCTAssertEqual(got.last, "shared while the app is running", "taken by the folder watch, no restart")
        XCTAssertEqual(ShareInbox.pending().count, 0)
    }
}
