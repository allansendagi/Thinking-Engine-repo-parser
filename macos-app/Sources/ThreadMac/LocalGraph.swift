import Foundation

/// The idea graph built entirely on this Mac from captures, by the on-device model. It's the
/// fallback the panel renders whenever the backend hasn't provided state — offline, first run
/// before a sync, or a future local-only mode. When the server's graph is available it wins
/// (it has the sharper extraction + real identity resolution); this keeps the core loop whole
/// when the server isn't there.
struct LocalGraph: Codable, Equatable {
    var ideas: [LocalIdea] = []

    static let empty = LocalGraph()

    /// Render as the shape every view already consumes, so nothing downstream changes.
    func asThinkingState() -> ThinkingStateResponse {
        let ordered = ideas.sorted { $0.updatedAt > $1.updatedAt }
        return ThinkingStateResponse(
            topic: nil,
            currentIdeas: ordered.map {
                IdeaSummary(id: $0.id, title: $0.title, state: $0.state,
                            currentFormulation: $0.formulation, latestSource: $0.lastSource)
            },
            recentChanges: ordered.map {
                .init(ideaId: $0.id, ideaTitle: $0.title, formulation: $0.formulation,
                      createdAt: Self.iso($0.updatedAt))
            },
            decisions: [],
            openLoops: ordered.flatMap { idea in
                idea.openQuestions.filter { !$0.resolved }.map {
                    ThinkingStateResponse.OpenLoopEntry(
                        ideaId: idea.id, ideaTitle: idea.title, loopId: $0.id, statement: $0.statement,
                        resolved: false, createdAt: Self.iso(idea.updatedAt), latestSource: idea.lastSource
                    )
                }
            },
            contradictions: [],
            relatedIdeas: []
        )
    }

    func trace(_ id: String) -> IdeaTrace? {
        guard let idea = ideas.first(where: { $0.id == id }) else { return nil }
        return IdeaTrace(
            idea: IdeaDetail(
                id: idea.id, title: idea.title, state: idea.state, currentFormulation: idea.formulation,
                evolution: idea.evolution.map { EvolutionStep(formulation: $0.formulation, createdAt: Self.iso($0.at)) },
                openLoops: idea.openQuestions.map { OpenLoop(id: $0.id, statement: $0.statement, createdAt: Self.iso(idea.createdAt), resolved: $0.resolved) },
                decisions: [], relatedIdeaIds: [],
                createdAt: Self.iso(idea.createdAt), updatedAt: Self.iso(idea.updatedAt)
            ),
            provenance: idea.evolution.map {
                ProvenanceStep(formulation: $0.formulation, createdAt: Self.iso($0.at),
                               sourceText: nil, sourceRole: "user", source: $0.source, sourceUrl: nil,
                               conversationId: nil)
            }
        )
    }

    private static let isoFormatter = ISO8601DateFormatter()
    static func iso(_ d: Date) -> String { isoFormatter.string(from: d) }
}

struct LocalIdea: Codable, Equatable, Identifiable {
    let id: String
    var title: String
    var formulation: String
    var state: String
    var evolution: [Step]
    var openQuestions: [LocalOpenLoop]
    var createdAt: Date
    var updatedAt: Date
    var sourceCaptureIds: [String]
    var lastSource: String?

    struct Step: Codable, Equatable {
        var formulation: String
        var at: Date
        var source: String?
    }

    static func new(id: String = "local_" + UUID().uuidString, from d: OnDeviceModel.GraphDelta, captureId: String, at now: Date = Date()) -> LocalIdea {
        LocalIdea(
            id: id, title: d.title, formulation: d.formulation, state: d.state,
            evolution: [Step(formulation: d.formulation, at: now, source: nil)],
            openQuestions: d.openQuestion.map { [LocalOpenLoop(id: "loop_" + UUID().uuidString, statement: $0, resolved: false)] } ?? [],
            createdAt: now, updatedAt: now, sourceCaptureIds: [captureId], lastSource: nil
        )
    }

    /// Fold a new capture that resolved to *this* idea: a fresh evolution step, updated
    /// formulation + state, and the open question added if it's genuinely new.
    mutating func extend(with d: OnDeviceModel.GraphDelta, captureId: String, at now: Date = Date()) {
        if d.formulation != formulation {
            evolution.append(Step(formulation: d.formulation, at: now, source: nil))
        }
        formulation = d.formulation
        // A follow-up can move an idea to a definite state, but never silently reset a
        // contested / rejected / established idea back to "developing" — only an explicit state
        // edit does that.
        if d.state != "developing", LocalIdeaDraft.allowedStates.contains(d.state) { state = d.state }
        if let q = d.openQuestion, !q.isEmpty,
           !openQuestions.contains(where: { $0.statement.caseInsensitiveCompare(q) == .orderedSame }) {
            openQuestions.append(LocalOpenLoop(id: "loop_" + UUID().uuidString, statement: q, resolved: false))
        }
        if !sourceCaptureIds.contains(captureId) { sourceCaptureIds.append(captureId) }
        updatedAt = now
    }
}

struct LocalOpenLoop: Codable, Equatable, Identifiable {
    let id: String
    var statement: String
    var resolved: Bool
}

extension OnDeviceModel.GraphDelta {
    /// Parse the JSON object `absorbCapture` asks for; tolerant of prose around it. Returns nil
    /// when there's no usable title.
    static func parse(_ raw: String) -> OnDeviceModel.GraphDelta? {
        guard let start = raw.firstIndex(of: "{"), let end = raw.lastIndex(of: "}"), start < end else { return nil }
        struct Wire: Decodable { var target: String?; var title: String?; var formulation: String?; var state: String?; var openQuestion: String? }
        guard
            let data = String(raw[start...end]).data(using: .utf8),
            let w = try? JSONDecoder().decode(Wire.self, from: data),
            let title = w.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty, !OnDeviceModel.looksUnusable(title)
        else { return nil }
        let q = w.openQuestion?.trimmingCharacters(in: .whitespacesAndNewlines)
        let target = w.target?.trimmingCharacters(in: .whitespacesAndNewlines)
        return OnDeviceModel.GraphDelta(
            target: (target?.isEmpty ?? true) ? "new" : target!,
            title: title,
            formulation: (w.formulation?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 } ?? title,
            state: (w.state ?? "developing").lowercased(),
            openQuestion: (q?.isEmpty ?? true) || q?.lowercased() == "null" ? nil : q
        )
    }
}

enum OnDeviceGraph {
    /// Pure: fold a delta + its capture into the graph. `target == "new"` (or an id that isn't
    /// present) creates an idea; otherwise the matched idea is extended.
    static func fold(_ delta: OnDeviceModel.GraphDelta, captureId: String, into graph: LocalGraph, at now: Date = Date()) -> LocalGraph {
        var g = graph
        if delta.target != "new", let i = g.ideas.firstIndex(where: { $0.id == delta.target }) {
            g.ideas[i].extend(with: delta, captureId: captureId, at: now)
        } else {
            g.ideas.append(LocalIdea.new(from: delta, captureId: captureId, at: now))
        }
        return g
    }
}
