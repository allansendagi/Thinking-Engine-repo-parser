import XCTest
@testable import ThreadMac

/// `LocalStore.mostRecentSnapshot()` is what lets the reconnect screen still show your ideas
/// after the app has lost track of which account is yours.
final class RecoveryTests: XCTestCase {
    private var scratch: URL!

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("thread-recovery-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        LocalStore.directoryOverride = scratch
    }

    override func tearDownWithError() throws {
        LocalStore.directoryOverride = nil
        try? FileManager.default.removeItem(at: scratch)
    }

    private func snapshot(ideaTitles: [String], savedAt: Date) -> LocalSnapshot {
        let ideas = ideaTitles.enumerated().map { i, t in
            IdeaSummary(id: "i\(i)", title: t, state: "developing", currentFormulation: t, latestSource: "claude")
        }
        let ts = ThinkingStateResponse(
            topic: nil, currentIdeas: ideas, recentChanges: [], decisions: [],
            openLoops: [], contradictions: [], relatedIdeas: []
        )
        return LocalSnapshot(
            thinkingState: ideas.isEmpty ? nil : ts, traces: [:], pendingCaptures: [], pendingEdits: [],
            localGraph: .empty, embeddings: [:], savedAt: savedAt
        )
    }

    func testReturnsNilWhenNoSnapshots() {
        XCTAssertNil(LocalStore.mostRecentSnapshot())
    }

    func testPrefersASnapshotThatHasIdeasOverAMoreRecentEmptyOne() {
        LocalStore.save(snapshot(ideaTitles: ["Computable authority", "Local first"],
                                 savedAt: Date(timeIntervalSince1970: 1_000)),
                        userId: "user_real0000000000000000000")
        LocalStore.save(snapshot(ideaTitles: [], savedAt: Date(timeIntervalSince1970: 9_999)),
                        userId: "user_empty000000000000000000")

        let best = LocalStore.mostRecentSnapshot()
        XCTAssertEqual(best?.userId, "user_real0000000000000000000")
        XCTAssertEqual(best?.snapshot.thinkingState?.currentIdeas.count, 2)
    }

    func testAmongSnapshotsWithIdeasTheMostRecentlyWrittenWins() throws {
        LocalStore.save(snapshot(ideaTitles: ["old"], savedAt: Date(timeIntervalSince1970: 1_000)),
                        userId: "user_old00000000000000000000")
        // Nudge mtimes apart deterministically.
        let old = scratch.appendingPathComponent("snapshot-user_old00000000000000000000.json")
        try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1_000)], ofItemAtPath: old.path)

        LocalStore.save(snapshot(ideaTitles: ["new"], savedAt: Date(timeIntervalSince1970: 2_000)),
                        userId: "user_new00000000000000000000")
        let new = scratch.appendingPathComponent("snapshot-user_new00000000000000000000.json")
        try FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: new.path)

        XCTAssertEqual(LocalStore.mostRecentSnapshot()?.userId, "user_new00000000000000000000")
    }

    func testIgnoresTheAnonymousSlot() {
        LocalStore.save(snapshot(ideaTitles: ["anon idea"], savedAt: Date()), userId: nil) // -> snapshot-anon.json
        XCTAssertNil(LocalStore.mostRecentSnapshot(), "the anon snapshot is not an account to recover")
    }
}
