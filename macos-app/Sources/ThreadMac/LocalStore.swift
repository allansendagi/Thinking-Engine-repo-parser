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
    /// Captures made on this Mac that haven't been confirmed by the backend yet — kept so an
    /// offline capture survives a relaunch and still syncs later. See `PendingCapture`.
    var pendingCaptures: [PendingCapture]
    /// Field edits (rename / state / resolve-loop / delete) made here and not yet synced.
    var pendingEdits: [PendingEdit]
    /// The idea graph built on this Mac by the on-device model — the fallback rendered whenever
    /// the backend hasn't provided state. See `LocalGraph`.
    var localGraph: LocalGraph
    /// ideaId → on-device semantic vector for its current text. Recomputed only when the text
    /// changes (see `EmbeddingEntry.contentHash`). Powers meaning-based recall + "Related".
    var embeddings: [String: EmbeddingEntry]
    var savedAt: Date

    static let empty = LocalSnapshot(
        thinkingState: nil, traces: [:], pendingCaptures: [], pendingEdits: [],
        localGraph: .empty, embeddings: [:], savedAt: .distantPast
    )

    // Hand-rolled so a snapshot written before these fields existed still decodes.
    init(
        thinkingState: ThinkingStateResponse?,
        traces: [String: IdeaTrace],
        pendingCaptures: [PendingCapture],
        pendingEdits: [PendingEdit],
        localGraph: LocalGraph,
        embeddings: [String: EmbeddingEntry],
        savedAt: Date
    ) {
        self.thinkingState = thinkingState
        self.traces = traces
        self.pendingCaptures = pendingCaptures
        self.pendingEdits = pendingEdits
        self.localGraph = localGraph
        self.embeddings = embeddings
        self.savedAt = savedAt
    }

    enum CodingKeys: String, CodingKey {
        case thinkingState, traces, pendingCaptures, pendingEdits, localGraph, embeddings, savedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        thinkingState = try c.decodeIfPresent(ThinkingStateResponse.self, forKey: .thinkingState)
        traces = try c.decodeIfPresent([String: IdeaTrace].self, forKey: .traces) ?? [:]
        pendingCaptures = try c.decodeIfPresent([PendingCapture].self, forKey: .pendingCaptures) ?? []
        pendingEdits = try c.decodeIfPresent([PendingEdit].self, forKey: .pendingEdits) ?? []
        localGraph = try c.decodeIfPresent(LocalGraph.self, forKey: .localGraph) ?? .empty
        embeddings = try c.decodeIfPresent([String: EmbeddingEntry].self, forKey: .embeddings) ?? [:]
        savedAt = try c.decodeIfPresent(Date.self, forKey: .savedAt) ?? .distantPast
    }
}

/// A cached idea vector plus the hash of the text it was computed from, so a re-embed happens
/// only when the idea's title/formulation actually changes.
struct EmbeddingEntry: Codable, Equatable {
    var contentHash: Int
    var vector: [Float]
}

/// The on-device model's first read of a capture: enough to show a real card immediately.
struct LocalIdeaDraft: Codable, Equatable {
    var title: String
    var formulation: String
    var state: String
    var openQuestion: String?

    static let allowedStates: Set<String> = ["developing", "established", "contested", "rejected", "dormant"]

    /// Parse the small JSON object `OnDeviceModel.extractIdea` asks the model for. Tolerant of
    /// prose around the object; returns nil when there's no usable idea.
    static func parse(_ raw: String) -> LocalIdeaDraft? {
        guard let start = raw.firstIndex(of: "{"), let end = raw.lastIndex(of: "}"), start < end else { return nil }
        let json = String(raw[start...end])
        struct Wire: Decodable { var title: String?; var formulation: String?; var state: String?; var openQuestion: String? }
        guard
            let data = json.data(using: .utf8),
            let w = try? JSONDecoder().decode(Wire.self, from: data),
            let title = w.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty, !OnDeviceModel.looksUnusable(title)
        else { return nil }
        let state = (w.state ?? "developing").lowercased()
        let q = w.openQuestion?.trimmingCharacters(in: .whitespacesAndNewlines)
        return LocalIdeaDraft(
            title: title,
            formulation: (w.formulation?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 } ?? title,
            state: allowedStates.contains(state) ? state : "developing",
            openQuestion: (q?.isEmpty ?? true) || q?.lowercased() == "null" ? nil : q
        )
    }
}

/// A capture that has been written locally but not yet round-tripped to the backend. It shows in
/// the panel right away (with the on-device draft) and is retried on every successful refresh
/// until the backend confirms it — then it's dropped and the authoritative graph takes over.
struct PendingCapture: Codable, Identifiable, Equatable {
    let id: String
    let text: String
    var draft: LocalIdeaDraft?
    let createdAt: Date
    var status: Status

    enum Status: String, Codable { case extracting, queued, syncing, failed }
}

enum LocalStore {
    /// Test seam: when set, snapshots read/write here instead of `~/Library/Application
    /// Support/Thread`. Always nil in the shipping app.
    static var directoryOverride: URL?

    private static var dirURL: URL {
        directoryOverride
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Thread", isDirectory: true)
    }

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

    /// The newest per-account snapshot on disk, whatever account it belongs to. Recovery needs
    /// this: when the credential is gone the app no longer knows its own userId, but the last
    /// graph it synced is still here and should stay on screen so a token loss never *looks*
    /// like data loss. A snapshot that actually holds ideas wins over an empty one; among
    /// equals, most recently written wins. Skips the anonymous (`snapshot-anon.json`) slot.
    static func mostRecentSnapshot() -> (userId: String, snapshot: LocalSnapshot)? {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: dirURL, includingPropertiesForKeys: [.contentModificationDateKey]
        ) else { return nil }

        func ideaCount(_ s: LocalSnapshot) -> Int {
            (s.thinkingState?.currentIdeas.count ?? 0) + s.localGraph.ideas.count
        }

        var best: (userId: String, snapshot: LocalSnapshot, hasIdeas: Bool, mtime: Date)?
        for url in entries {
            let name = url.lastPathComponent
            guard name.hasPrefix("snapshot-"), url.pathExtension == "json" else { continue }
            let tag = String(name.dropFirst("snapshot-".count).dropLast(".json".count))
            guard tag.hasPrefix("user_") else { continue }
            guard let data = try? Data(contentsOf: url),
                  let snap = try? JSONDecoder().decode(LocalSnapshot.self, from: data) else { continue }
            let mtime = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate ?? .distantPast
            let hasIdeas = ideaCount(snap) > 0
            if let b = best {
                let better = (hasIdeas && !b.hasIdeas) || (hasIdeas == b.hasIdeas && mtime > b.mtime)
                if better { best = (tag, snap, hasIdeas, mtime) }
            } else {
                best = (tag, snap, hasIdeas, mtime)
            }
        }
        return best.map { ($0.userId, $0.snapshot) }
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
