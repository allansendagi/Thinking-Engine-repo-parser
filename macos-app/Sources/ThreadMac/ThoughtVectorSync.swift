import Foundation

/// Native-first meaning-vectors for the server's idea mining. After each sync, this asks the
/// server which thoughts have no vector from this Mac's model yet, embeds them on-device with
/// Apple's NaturalLanguage model (`Embeddings`), and uploads the vectors. Nothing is sent to a
/// cloud embedding provider: the server uses these vectors to group thoughts into ideas by
/// meaning, and only falls back to a cloud model if it's explicitly configured and no Mac has
/// embedded a thought.
///
/// Quiet and bounded: one pass at a time, a capped number of thoughts per pass, off the main
/// actor, and any failure just waits for the next sync.
actor ThoughtVectorSync {
    static let shared = ThoughtVectorSync()

    private var running = false
    private let batchSize = 100
    private let maxPerPass = 1_000

    func run(client: APIClient) async {
        guard !running, Embeddings.isAvailable, let model = Embeddings.modelId else { return }
        running = true
        defer { running = false }

        var done = 0
        while done < maxPerPass {
            guard let pending = try? await client.thoughtsNeedingVectors(model: model, limit: batchSize),
                  !pending.isEmpty else { return }
            let items: [(id: String, vector: [Float])] = pending.compactMap { t in
                Embeddings.vector(for: t.text).map { (t.id, $0) }
            }
            guard !items.isEmpty, (try? await client.uploadThoughtVectors(model: model, items: items)) != nil else { return }
            done += items.count
            if pending.count < batchSize { return }
        }
    }
}
