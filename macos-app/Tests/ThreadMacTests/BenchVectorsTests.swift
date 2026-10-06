import XCTest
@testable import ThreadMac

/// Produces the thinking bench's native vectors: the bench texts embedded with the exact on-device
/// model and pooling the app uses (`Embeddings`), so the server-side bench scores matching by
/// meaning with Apple's model, not a stand-in. Skipped unless BENCH_TEXTS is set -- run by the
/// "Bench vectors" workflow, or locally:
///
///   bun src/bench/dumpTexts.ts > /tmp/bench-texts.json
///   BENCH_TEXTS=/tmp/bench-texts.json BENCH_VECTORS_OUT=../src/bench/vectors.apple.json \
///     swift test --filter BenchVectorsTests
final class BenchVectorsTests: XCTestCase {
    func testEmbedBenchTexts() throws {
        let env = ProcessInfo.processInfo.environment
        guard let input = env["BENCH_TEXTS"], let output = env["BENCH_VECTORS_OUT"] else {
            throw XCTSkip("BENCH_TEXTS / BENCH_VECTORS_OUT not set")
        }
        // The contextual model's asset (~100 MB) downloads on first use. The bench needs THAT model
        // -- it's what real Macs run -- so wait for it (BENCH_ASSET_WAIT seconds, default 60), and
        // only then fall back to the sentence model built into macOS. Same chain as the app.
        let wait = Double(env["BENCH_ASSET_WAIT"] ?? "") ?? 60
        let deadline = Date().addingTimeInterval(wait)
        // Spin the run loop (not sleep) in case the asset callback is delivered on it.
        while !Embeddings.isAvailable && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(5)) }
        print("BenchVectors: contextual model available=\(Embeddings.isAvailable) after waiting up to \(Int(wait))s")
        guard let model = NativeThoughtEmbedding.currentModel else {
            return XCTFail("No native Apple embedding model is available on this machine")
        }
        let texts = try JSONDecoder().decode([String].self, from: Data(contentsOf: URL(fileURLWithPath: input)))
        var vectors: [String: [Float]] = [:]
        for t in texts {
            if let e = NativeThoughtEmbedding.embed(t), e.model == model { vectors[t] = e.vector }
        }
        XCTAssertEqual(vectors.count, texts.count, "every bench text should embed")
        struct Out: Encodable { let model: String; let vectors: [String: [Float]] }
        try JSONEncoder().encode(Out(model: model, vectors: vectors)).write(to: URL(fileURLWithPath: output))
    }
}
