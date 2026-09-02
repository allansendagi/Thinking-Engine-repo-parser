import Foundation

/// Mirrors src/mcp/tools.ts / src/api/handler.ts's JSON shapes exactly -- the backend is the
/// single source of truth for these; this file has no independent logic of its own.

/// Maps a backend source slug to its display label. Shared by IdeaSummary, OpenLoopEntry and
/// ProvenanceStep so the panel labels a tool the same way everywhere ("ChatGPT · 24m ago").
func displaySourceLabel(_ source: String?) -> String? {
    switch source {
    case "chatgpt": return "ChatGPT"
    case "claude": return "Claude"
    case "gemini": return "Gemini"
    case "cursor": return "Cursor"
    case "paste": return "Pasted"
    default: return nil
    }
}

struct IdeaSummary: Codable, Identifiable {
    let id: String
    let title: String
    let state: String
    let currentFormulation: String
    /// Tool the idea was most recently developed in ("chatgpt" | ...), or nil. Added by the
    /// backend's ThinkingState.currentIdeas; optional so older payloads still decode.
    var latestSource: String?

    var sourceLabel: String? { displaySourceLabel(latestSource) }
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
        /// When the loop was raised; drives the "· 24m ago" in the row meta. Optional so older
        /// payloads still decode.
        var createdAt: String?
        /// Tool the parent idea was most recently developed in. Optional; mirrors IdeaSummary.
        var latestSource: String?
        var id: String { loopId }

        var sourceLabel: String? { displaySourceLabel(latestSource) }
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

/// A decision as it appears *inside an idea* (GET /v1/ideas/:id or /trace). Distinct from
/// ThinkingStateResponse.Decision, which is the top-level shape and carries ideaId/ideaTitle.
struct IdeaDecision: Codable, Identifiable {
    let id: String
    let statement: String
    let decidedAt: String
}

struct IdeaDetail: Codable, Identifiable {
    let id: String
    let title: String
    let state: String
    let currentFormulation: String
    let evolution: [EvolutionStep]
    let openLoops: [OpenLoop]
    let decisions: [IdeaDecision]
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

    var sourceLabel: String? { displaySourceLabel(source) }
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

/// GET /v1/account -- plan + entitlement for the footer + paywall.
struct AccountStatus: Codable {
    let plan: String            // "free" | "pro"
    let status: String          // free | active | past_due | canceled | incomplete
    let isPro: Bool
    let canCapture: Bool        // may this account still capture (Free cap not hit / Pro active)?
    let ideaCount: Int
    let ideaCap: Int
    let currentPeriodEnd: String?
    let email: String?
    let billingEnabled: Bool     // is Paddle configured on the backend at all?

    var footerLabel: String {
        if !billingEnabled { return "Cloud" }
        if isPro { return status == "canceled" ? "Pro (ending)" : "Pro" }
        return "Free · \(ideaCount)/\(ideaCap)"
    }
}

struct BillingURL: Codable {
    let url: String
}

struct ContinueResponse: Codable {
    let text: String
}

struct APIErrorBody: Codable {
    let error: String?
}
