import XCTest
@testable import ThreadMac

/// The persistence half of resumable backfill: an unfinished run must survive save→load with its
/// resume index intact, and a fresh `AppState` must offer to pick it up. The failure this guards
/// against is silent -- a dropped `backfillJob` on decode just makes every resume start from 0.
@MainActor
final class BackfillResumeTests: XCTestCase {
    private var localDir: URL!
    private var credDir: URL!

    override func setUpWithError() throws {
        localDir = FileManager.default.temporaryDirectory.appendingPathComponent("thread-bfresume-l-\(UUID().uuidString)", isDirectory: true)
        credDir = FileManager.default.temporaryDirectory.appendingPathComponent("thread-bfresume-c-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: localDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: credDir, withIntermediateDirectories: true)
        LocalStore.directoryOverride = localDir
        CredentialStore.directoryOverride = credDir
        UserDefaults.standard.removeObject(forKey: "thread.lastKnownEmail")
        UserDefaults.standard.removeObject(forKey: "thread.deliberateSignOut")
        UserDefaults.standard.removeObject(forKey: "thread.backfillCompleted")
    }

    override func tearDownWithError() throws {
        LocalStore.directoryOverride = nil
        CredentialStore.directoryOverride = nil
        UserDefaults.standard.removeObject(forKey: "thread.lastKnownEmail")
        UserDefaults.standard.removeObject(forKey: "thread.deliberateSignOut")
        UserDefaults.standard.removeObject(forKey: "thread.backfillCompleted")
        try? FileManager.default.removeItem(at: localDir)
        try? FileManager.default.removeItem(at: credDir)
    }

    private func job(done: Int) -> BackfillJob {
        BackfillJob(
            kind: .claude,
            sourcePath: "/Users/x/Downloads/data.zip",
            sourceModified: Date(timeIntervalSince1970: 1_700_000_050),
            conversationsTotal: 120,
            conversationsDone: done,
            ideaCountAtStart: 8,
            startedAt: Date(timeIntervalSince1970: 1_700_000_000),
            updatedAt: Date(timeIntervalSince1970: 1_700_000_090)
        )
    }

    /// A fully-populated snapshot (the fields `persistSnapshot()` rewrites every save) carrying a
    /// job must come back from disk with the job -- and its resume index -- untouched.
    func testJobSurvivesSaveLoadAlongsideEveryOtherSnapshotField() {
        let uid = "user_resume0000000000000000000"
        let idea = IdeaSummary(id: "i1", title: "Computable authority", state: "developing",
                               currentFormulation: "Authority must be runnable.", latestSource: "claude")
        var snap = LocalSnapshot(
            thinkingState: ThinkingStateResponse(topic: nil, currentIdeas: [idea], recentChanges: [],
                                                 decisions: [], openLoops: [], contradictions: [], relatedIdeas: []),
            traces: [:],
            pendingCaptures: [PendingCapture(id: "p1", text: "t", draft: nil,
                                             createdAt: Date(timeIntervalSince1970: 1_700_000_100), status: .queued)],
            pendingEdits: [PendingEdit.rename("i1", "renamed")],
            localGraph: .empty,
            embeddings: ["i1": EmbeddingEntry(contentHash: 42, vector: [0.1, 0.2, 0.3])],
            savedAt: Date(timeIntervalSince1970: 1_700_000_120)
        )
        snap.backfillJob = job(done: 45)
        LocalStore.save(snap, userId: uid)

        let back = LocalStore.load(userId: uid)
        XCTAssertEqual(back?.backfillJob, job(done: 45))
        XCTAssertEqual(back?.backfillJob?.conversationsDone, 45)
        XCTAssertEqual(back?.embeddings["i1"]?.vector, [0.1, 0.2, 0.3])   // other fields still round-trip
        XCTAssertEqual(back?.pendingEdits.count, 1)
    }

    /// A fresh app, paired, with an unfinished job on disk offers to resume it -- even though
    /// `backfillCompleted` is set (the run stopped part-way, so there's still thinking to recover).
    func testFreshAppStateOffersResumeForAnUnfinishedJob() {
        let uid = "user_resume0000000000000000000"
        CredentialStore.save(userId: uid, token: "tok", email: "a@b.com")
        UserDefaults.standard.set(true, forKey: "thread.backfillCompleted")

        var snap = LocalSnapshot.empty
        snap.backfillJob = job(done: 45)
        LocalStore.save(snap, userId: uid)

        let app = AppState()
        app.checkForBackfill()

        guard case .resumable(let j) = app.backfill else {
            return XCTFail("expected .resumable, got \(app.backfill)")
        }
        XCTAssertEqual(j.conversationsDone, 45)
        XCTAssertEqual(j.sourceLabel, "Claude")
    }

    /// No job on disk + `backfillCompleted` set -> the offer stays closed (unchanged behaviour).
    func testNoJobAndCompletedStaysIdle() {
        let uid = "user_resume0000000000000000000"
        CredentialStore.save(userId: uid, token: "tok", email: "a@b.com")
        UserDefaults.standard.set(true, forKey: "thread.backfillCompleted")
        LocalStore.save(LocalSnapshot.empty, userId: uid)

        let app = AppState()
        app.checkForBackfill()

        XCTAssertEqual(app.backfill, .idle)
    }
}
