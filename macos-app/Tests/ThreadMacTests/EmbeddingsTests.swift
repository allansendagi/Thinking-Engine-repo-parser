import XCTest
@testable import ThreadMac

final class EmbeddingsTests: XCTestCase {

    func testStableHashIsDeterministicAndTextSensitive() {
        XCTAssertEqual(stableHash("Computable Authority — must be verifiable"),
                       stableHash("Computable Authority — must be verifiable"))
        XCTAssertNotEqual(stableHash("a"), stableHash("b"))
        XCTAssertNotEqual(stableHash("idea one"), stableHash("idea two"))
    }

    func testCosineBasics() {
        XCTAssertEqual(cosine([1, 0, 0], [1, 0, 0]), 1, accuracy: 1e-6)
        XCTAssertEqual(cosine([1, 0], [0, 1]), 0, accuracy: 1e-6)
        XCTAssertEqual(cosine([1, 0], [-1, 0]), -1, accuracy: 1e-6)
        XCTAssertEqual(cosine([2, 0], [5, 0]), 1, accuracy: 1e-6)   // magnitude-invariant
        XCTAssertEqual(cosine([], []), 0)
        XCTAssertEqual(cosine([1, 2], [1, 2, 3]), 0)                // mismatched dims
    }

    func testMeanVector() {
        XCTAssertEqual(meanVector([[0, 0], [2, 4], [4, 8]])!, [2, 4])
        XCTAssertNil(meanVector([]))
    }

    func testCentered() {
        XCTAssertEqual(centered([3, 5], by: [1, 1]), [2, 4])
        XCTAssertEqual(centered([3, 5], by: [1, 1, 1]), [3, 5])   // dim mismatch -> unchanged
    }

    /// Centering is what makes the ranking usable: three vectors sharing a big common component
    /// plus a small distinguishing one. Raw cosine barely separates them; centered cosine does.
    func testCenteringSeparatesOtherwiseSimilarVectors() {
        let base: [Float] = [10, 10, 10, 10]
        let a = zip(base, [1, 0, 0, 0] as [Float]).map(+)   // "topic A"
        let a2 = zip(base, [0.9, 0.1, 0, 0] as [Float]).map(+) // near A
        let b = zip(base, [0, 0, 1, 0] as [Float]).map(+)   // "topic B"

        // Raw: everything looks ~identical.
        XCTAssertGreaterThan(cosine(a, b), 0.99)

        // Centered against the corpus: A↔A2 stays high, A↔B collapses.
        let out = topSimilar(
            to: a,
            among: [("a2", a2), ("b", b)],
            floor: 0.2, limit: 3
        )
        XCTAssertEqual(out.first?.id, "a2")
        XCTAssertFalse(out.contains { $0.id == "b" })
    }

    func testTopSimilarRespectsLimitFloorAndExclude() {
        let mean: [Float] = [0, 0, 0]
        let q: [Float] = [1, 0, 0]
        let cands: [(id: String, vector: [Float])] = [
            ("self", [1, 0, 0]),
            ("close", [0.9, 0.4, 0]),
            ("mid", [0.4, 0.9, 0]),
            ("far", [-1, 0, 0]),
        ]
        _ = mean
        let out = topSimilar(to: q, among: cands, floor: -2, limit: 2, exclude: ["self"])
        XCTAssertEqual(out.count, 2)
        XCTAssertEqual(out.map(\.id), ["close", "mid"])
        XCTAssertFalse(out.contains { $0.id == "self" })

        let gated = topSimilar(to: q, among: cands, floor: 0.99, limit: 5, exclude: ["self"])
        XCTAssertTrue(gated.isEmpty)   // nothing that close after centering
    }

    func testEmbeddingEntryRoundTrips() throws {
        let e = EmbeddingEntry(contentHash: 12345, vector: [0.1, -0.2, 0.3])
        let back = try JSONDecoder().decode(EmbeddingEntry.self, from: JSONEncoder().encode(e))
        XCTAssertEqual(back, e)
    }

    func testSnapshotWithoutEmbeddingsStillDecodes() throws {
        let legacy = #"{"traces":{},"pendingCaptures":[],"pendingEdits":[],"savedAt":751000000}"#.data(using: .utf8)!
        let back = try JSONDecoder().decode(LocalSnapshot.self, from: legacy)
        XCTAssertTrue(back.embeddings.isEmpty)
    }
}
