import Foundation

/// Mirrors src/mcp/tools.ts / src/api/handler.ts's JSON shapes exactly -- the backend is the
/// single source of truth for these; this file has no independent logic of its own.

struct IdeaSummary: Codable, Identifiable {
    let id: String
    let title: String
    let state: String
    let currentFormulation: String
}

struct SearchResult: Codable, Identifiable {
    let id: String
    let title: String
    let state: String
    let currentFormulation: String
    let score: Double
}

struct ThinkingStateResponse: Codable {
    struct RecentChange: Codable, Identifiable {
        let ideaId: String
        let ideaTitle: String
        let formulation: String
        let createdAt: String
        var id: String { ideaId + createdAt }
    }
    struct Decision: Codable, Identifiable {
        let ideaId: String
        let ideaTitle: String
        let statement: String
        let decidedAt: String
        var id: String { ideaId + decidedAt }
    }
    struct OpenLoopEntry: Codable, Identifiable {
        let ideaId: String
        let ideaTitle: String
        let loopId: String
        let statement: String
        let resolved: Bool
        var id: String { loopId }
    }
    struct RelatedIdea: Codable, Identifiable {
        let id: String
        let title: String
    }

    let topic: String?
    let currentIdeas: [IdeaSummary]
    let recentChanges: [RecentChange]
    let decisions: [Decision]
    let openLoops: [OpenLoopEntry]
    let contradictions: [RecentChange]
    let relatedIdeas: [RelatedIdea]
}

struct OpenLoop: Codable, Identifiable {
    let id: String
    let statement: String
    let createdAt: String
    let resolved: Bool
}

struct EvolutionStep: Codable, Identifiable {
    let formulation: String
    let createdAt: String
    var id: String { formulation + createdAt }
}

struct IdeaDetail: Codable, Identifiable {
    let id: String
    let title: String
    let state: String
    let currentFormulation: String
    let evolution: [EvolutionStep]
    let openLoops: [OpenLoop]
    let decisions: [ThinkingStateResponse.Decision]
    let relatedIdeaIds: [String]
    let createdAt: String
    let updatedAt: String
}

struct ProvenanceStep: Codable, Identifiable {
    let formulation: String
    let createdAt: String
    let sourceText: String?
    let sourceRole: String?
    /// Tool this step was captured from: "chatgpt" | "claude" | "gemini" | "cursor" | "paste".
    let source: String?
    var id: String { formulation + createdAt }

    var sourceLabel: String? {
        switch source {
        case "chatgpt": return "ChatGPT"
        case "claude": return "Claude"
        case "gemini": return "Gemini"
        case "cursor": return "Cursor"
        case "paste": return "Pasted"
        default: return nil
        }
    }
}

struct IdeaTrace: Codable {
    let idea: IdeaDetail
    let provenance: [ProvenanceStep]
}

struct IngestResult: Codable {
    let newCanonicalEvents: Int
    let newCognitiveEvents: Int
    let rejectedExtractions: Int
    let ideaCount: Int
}

struct CreatedUser: Codable {
    let userId: String
    let token: String
}

struct ContinueResponse: Codable {
    let text: String
}

struct APIErrorBody: Codable {
    let error: String?
}
