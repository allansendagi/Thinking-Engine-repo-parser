import Foundation

/// A field edit made on this Mac that hasn't been confirmed by the backend yet. Edits are
/// last-write-wins per field — there is no merge to do for "set the title" or "mark this loop
/// resolved" — so the model is deliberately simple: apply locally at once, queue the call, and
/// overlay the queue on top of whatever the server returns until it lands.
struct PendingEdit: Codable, Identifiable, Equatable {
    let id: String
    let ideaId: String
    let kind: Kind
    let createdAt: Date
    var attempts: Int = 0

    enum Kind: Codable, Equatable {
        case rename(String)
        case setState(String)
        case resolveLoop(loopId: String, resolved: Bool)
        case delete
    }

    static func rename(_ ideaId: String, _ title: String) -> PendingEdit {
        PendingEdit(id: UUID().uuidString, ideaId: ideaId, kind: .rename(title), createdAt: Date())
    }
    static func setState(_ ideaId: String, _ state: String) -> PendingEdit {
        PendingEdit(id: UUID().uuidString, ideaId: ideaId, kind: .setState(state), createdAt: Date())
    }
    static func resolveLoop(_ ideaId: String, loopId: String, resolved: Bool) -> PendingEdit {
        PendingEdit(id: UUID().uuidString, ideaId: ideaId,
                    kind: .resolveLoop(loopId: loopId, resolved: resolved), createdAt: Date())
    }
    static func delete(_ ideaId: String) -> PendingEdit {
        PendingEdit(id: UUID().uuidString, ideaId: ideaId, kind: .delete, createdAt: Date())
    }
}

// MARK: - Applying an edit to the local read model

/// Fold one edit into a queue: drop entries the new edit makes moot so the backend never gets a
/// pointless "rename to A then rename to B", and a delete supersedes everything for that idea.
func coalesced(_ queue: [PendingEdit], adding edit: PendingEdit) -> [PendingEdit] {
    var q = queue
    switch edit.kind {
    case .delete:
        q.removeAll { $0.ideaId == edit.ideaId }
    case .rename:
        q.removeAll { $0.ideaId == edit.ideaId && isRename($0.kind) }
    case .setState:
        q.removeAll { $0.ideaId == edit.ideaId && isSetState($0.kind) }
    case .resolveLoop(let loopId, _):
        q.removeAll { if case .resolveLoop(let l, _) = $0.kind { return l == loopId }; return false }
    }
    q.append(edit)
    return q
}

private func isRename(_ k: PendingEdit.Kind) -> Bool { if case .rename = k { return true }; return false }
private func isSetState(_ k: PendingEdit.Kind) -> Bool { if case .setState = k { return true }; return false }

func applyAll(_ edits: [PendingEdit], to state: ThinkingStateResponse) -> ThinkingStateResponse {
    edits.reduce(state) { apply($1.kind, to: $0, ideaId: $1.ideaId) }
}

func apply(_ kind: PendingEdit.Kind, to state: ThinkingStateResponse, ideaId: String) -> ThinkingStateResponse {
    var ideas = state.currentIdeas
    var loops = state.openLoops

    switch kind {
    case .rename(let title):
        ideas = ideas.map { $0.id == ideaId ? $0.with(title: title) : $0 }
        loops = loops.map { $0.ideaId == ideaId ? $0.with(ideaTitle: title) : $0 }
    case .setState(let s):
        ideas = ideas.map { $0.id == ideaId ? $0.with(state: s) : $0 }
    case .resolveLoop(let loopId, let resolved):
        loops = loops.map { $0.loopId == loopId ? $0.with(resolved: resolved) : $0 }
    case .delete:
        ideas.removeAll { $0.id == ideaId }
        loops.removeAll { $0.ideaId == ideaId }
    }

    return ThinkingStateResponse(
        topic: state.topic, currentIdeas: ideas, recentChanges: state.recentChanges,
        decisions: state.decisions, openLoops: loops, contradictions: state.contradictions,
        relatedIdeas: state.relatedIdeas
    )
}

/// Overlay the edits that touch `trace.idea.id` onto a freshly fetched trace.
func applyAll(_ edits: [PendingEdit], to trace: IdeaTrace) -> IdeaTrace {
    let id = trace.idea.id
    return edits.filter { $0.ideaId == id }.reduce(trace) { t, e in
        switch e.kind {
        case .rename(let title):     return IdeaTrace(idea: t.idea.with(title: title), provenance: t.provenance)
        case .setState(let s):       return IdeaTrace(idea: t.idea.with(state: s), provenance: t.provenance)
        case .resolveLoop(let lid, let r):
            return IdeaTrace(idea: t.idea.with(loops: t.idea.openLoops.map {
                $0.id == lid ? $0.with(resolved: r) : $0
            }), provenance: t.provenance)
        case .delete:                return t   // the detail closes on delete; nothing to overlay
        }
    }
}

// MARK: - copy-with helpers (the model structs are value types with `let` fields)

extension IdeaSummary {
    func with(title: String? = nil, state: String? = nil) -> IdeaSummary {
        IdeaSummary(id: id, title: title ?? self.title, state: state ?? self.state,
                    currentFormulation: currentFormulation, latestSource: latestSource)
    }
}

extension ThinkingStateResponse.OpenLoopEntry {
    func with(ideaTitle: String? = nil, resolved: Bool? = nil) -> ThinkingStateResponse.OpenLoopEntry {
        ThinkingStateResponse.OpenLoopEntry(
            ideaId: ideaId, ideaTitle: ideaTitle ?? self.ideaTitle, loopId: loopId,
            statement: statement, resolved: resolved ?? self.resolved,
            createdAt: createdAt, latestSource: latestSource
        )
    }
}

extension OpenLoop {
    func with(resolved: Bool) -> OpenLoop {
        OpenLoop(id: id, statement: statement, createdAt: createdAt, resolved: resolved)
    }
}

extension IdeaDetail {
    func with(title: String? = nil, state: String? = nil, loops: [OpenLoop]? = nil) -> IdeaDetail {
        IdeaDetail(
            id: id, title: title ?? self.title, state: state ?? self.state,
            currentFormulation: currentFormulation, evolution: evolution,
            openLoops: loops ?? openLoops, decisions: decisions,
            relatedIdeaIds: relatedIdeaIds, createdAt: createdAt, updatedAt: updatedAt
        )
    }
}
