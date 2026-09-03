import Foundation
import NaturalLanguage

/// On-device semantic vectors for ideas, via Apple's `NLContextualEmbedding` — free, offline,
/// private. Powers recall by *meaning* (not just keyword) and the "Related" list on an idea.
/// One person has a few hundred ideas, so a plain in-memory scan is instant; no index needed.
///
/// The model's raw cosine similarities are badly compressed (every pair lands 0.85–0.93), so
/// nothing distinguishes. The fix — applied in `topSimilar` — is to mean-center the vectors
/// against the idea corpus before comparing, which strips the dominant "generic English"
/// component and spreads real matches (~0.25) away from unrelated ones (≤ 0).
enum Embeddings {
    private static let lock = NSLock()
    private static var loaded: NLContextualEmbedding?
    private static var settled = false        // gave up, or succeeded
    private static var requestingAssets = false

    /// True once the model is loaded. Until then (or if the platform lacks it) every caller
    /// falls back to keyword-only — a quiet capability check, not an error. On a fresh machine
    /// the ~100 MB model asset downloads in the background and this flips true afterwards.
    static var isAvailable: Bool { model != nil }

    private static var model: NLContextualEmbedding? {
        lock.lock(); defer { lock.unlock() }
        if let m = loaded { return m }
        if settled { return nil }
        guard let m = NLContextualEmbedding(language: .english) else { settled = true; return nil }
        if m.hasAvailableAssets {
            do { try m.load(); loaded = m; settled = true; return m }
            catch { settled = true; return nil }
        }
        if !requestingAssets {
            requestingAssets = true
            m.requestAssets { _, _ in
                Embeddings.lock.lock()
                Embeddings.requestingAssets = false
                Embeddings.settled = false        // let the next access retry the load
                Embeddings.lock.unlock()
            }
        }
        return nil
    }

    /// The text an idea is embedded from — compact, carries the thought.
    static func text(title: String, formulation: String) -> String {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let f = formulation.trimmingCharacters(in: .whitespacesAndNewlines)
        return f.isEmpty || f == t ? t : "\(t) — \(f)"
    }

    /// A mean-pooled vector for the text (not normalized — centering + normalization happen at
    /// compare time). Nil when the model isn't ready or the text is empty.
    static func vector(for text: String) -> [Float]? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, let m = model,
              let r = try? m.embeddingResult(for: t, language: .english) else { return nil }
        var sum = [Float](repeating: 0, count: m.dimension)
        var n = 0
        r.enumerateTokenVectors(in: t.startIndex..<t.endIndex) { v, _ in
            for i in 0..<min(v.count, sum.count) { sum[i] += Float(v[i]) }
            n += 1
            return true
        }
        guard n > 0 else { return nil }
        return sum.map { $0 / Float(n) }
    }
}

/// Deterministic across launches (unlike `String.hashValue`, which is per-process seeded) — so a
/// cached vector is reused until the idea's text genuinely changes. djb2-xor over UTF-8.
func stableHash(_ s: String) -> Int {
    var h: UInt64 = 5381
    for b in s.utf8 { h = (h &* 33) ^ UInt64(b) }
    return Int(bitPattern: UInt(truncatingIfNeeded: h))
}

// MARK: - Pure ranking (testable without the model)

func meanVector(_ vectors: [[Float]]) -> [Float]? {
    guard let d = vectors.first(where: { !$0.isEmpty })?.count else { return nil }
    var m = [Float](repeating: 0, count: d)
    var n: Float = 0
    for v in vectors where v.count == d {
        for i in 0..<d { m[i] += v[i] }
        n += 1
    }
    guard n > 0 else { return nil }
    return m.map { $0 / n }
}

func centered(_ v: [Float], by mean: [Float]) -> [Float] {
    v.count == mean.count ? zip(v, mean).map(-) : v
}

func cosine(_ a: [Float], _ b: [Float]) -> Float {
    guard a.count == b.count, !a.isEmpty else { return 0 }
    var dot: Float = 0, na: Float = 0, nb: Float = 0
    for i in a.indices { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
    let denom = (na.squareRoot() * nb.squareRoot())
    return denom > 0 ? dot / denom : 0
}

/// The ideas most similar in meaning to `query`, best first — mean-centered against the corpus,
/// above `floor`, at most `limit`, `exclude`d ids dropped.
func topSimilar(
    to query: [Float],
    among candidates: [(id: String, vector: [Float])],
    floor: Float,
    limit: Int,
    exclude: Set<String> = []
) -> [(id: String, score: Float)] {
    guard !candidates.isEmpty, let mean = meanVector(candidates.map(\.vector) + [query]) else { return [] }
    let q = centered(query, by: mean)
    return candidates
        .filter { !exclude.contains($0.id) }
        .map { (id: $0.id, score: cosine(q, centered($0.vector, by: mean))) }
        .filter { $0.score >= floor }
        .sorted { $0.score > $1.score }
        .prefix(limit)
        .map { $0 }
}

/// "Related thinking" is a higher bar than search — only surface a genuinely close idea.
let relatedIdeaFloor: Float = 0.20
let relatedIdeaLimit = 3
/// Semantic search casts a slightly wider net; keyword hits still rank above these.
let semanticSearchFloor: Float = 0.14
