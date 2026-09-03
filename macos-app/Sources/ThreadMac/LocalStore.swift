import Foundation

/// Local-first read layer. Everything the core loop needs to *show* — the idea list, recall
/// results, an idea's trace, the resume nudge — comes from this on-disk snapshot first, so the
/// panel renders instantly and keeps working with the network down. `AppState.refresh()` writes
/// the snapshot after every successful sync; for reads, the backend is a sync layer, not a
/// dependency.
///
/// One person's idea graph is small (hundreds of nodes), so the snapshot is a single JSON file
/// and recall is an in-memory scan — no SQLite until the data actually outgrows that.
struct LocalSnapshot: Codable {
    var thinkingState: ThinkingStateResponse?
    /// ideaId → full trace, filled lazily as ideas are opened so detail is instant next time.
    var traces: [String: IdeaTrace]
    var savedAt: Date

    static let empty = LocalSnapshot(thinkingState: nil, traces: [:], savedAt: .distantPast)
}

enum LocalStore {
    private static let dirURL: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Thread", isDirectory: true)
    }()

    /// Namespaced by account so signing in as a different user never surfaces the previous graph.
    private static func fileURL(for userId: String?) -> URL {
        let tag = userId.map { String($0.prefix(32)) } ?? "anon"
        return dirURL.appendingPathComponent("snapshot-\(tag).json")
    }

    static func load(userId: String?) -> LocalSnapshot? {
        guard let data = try? Data(contentsOf: fileURL(for: userId)) else { return nil }
        return try? JSONDecoder().decode(LocalSnapshot.self, from: data)
    }

    static func save(_ snapshot: LocalSnapshot, userId: String?) {
        try? FileManager.default.createDirectory(at: dirURL, withIntermediateDirectories: true)
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        try? data.write(to: fileURL(for: userId), options: .atomic)
    }

    static func clear(userId: String?) {
        try? FileManager.default.removeItem(at: fileURL(for: userId))
    }
}

/// Instant, offline recall. Token-AND match over title + current formulation, with title hits
/// weighted heavier and a whole-query title prefix bumped to the top. Returns the server's
/// `SearchResult` shape so the UI path is byte-identical online and off.
func localSearch(_ rawQuery: String, in ideas: [IdeaSummary]) -> [SearchResult] {
    let terms = rawQuery.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init)
    guard !terms.isEmpty else { return [] }
    let joined = terms.joined(separator: " ")

    var out: [SearchResult] = []
    for idea in ideas {
        let title = idea.title.lowercased()
        let body = idea.currentFormulation.lowercased()
        var score = 0.0
        var matchedEvery = true
        for t in terms {
            let inTitle = title.contains(t)
            let inBody = body.contains(t)
            if !inTitle && !inBody { matchedEvery = false; break }
            if inTitle { score += 3 }
            if inBody { score += 1 }
        }
        guard matchedEvery else { continue }
        if title.hasPrefix(joined) { score += 5 }
        else if title.contains(joined) { score += 2 }
        out.append(SearchResult(
            id: idea.id, title: idea.title, state: idea.state,
            currentFormulation: idea.currentFormulation, score: score
        ))
    }
    return out.sorted { $0.score == $1.score ? $0.title < $1.title : $0.score > $1.score }
}
