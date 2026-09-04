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
    /// Canonical URL of the conversation this step came from -- a "view source" link. Nil for
    /// pastes and data captured before the URL was recorded.
    let sourceUrl: String?
    /// Id of the source conversation. Present -> the captured transcript can be opened in Thread
    /// (GET /v1/conversations/:id). Optional so an older server still decodes.
    let conversationId: String?
    var id: String { formulation + createdAt }

    var sourceLabel: String? { displaySourceLabel(source) }
}

struct IdeaTrace: Codable {
    let idea: IdeaDetail
    let provenance: [ProvenanceStep]
}

/// One row of the "Activity" feed: a conversation Thread captured and the ideas it moved.
struct ConversationSummary: Codable, Identifiable {
    struct IdeaRef: Codable, Identifiable {
        let id: String
        let title: String
    }
    let conversationId: String
    let source: String
    let sourceUrl: String?
    let messageCount: Int
    let firstAt: String
    let lastAt: String
    let ideas: [IdeaRef]

    var id: String { conversationId }
    var sourceLabel: String { displaySourceLabel(source) ?? source.capitalized }
}

/// The captured messages behind an idea -- the "evidence" layer. Fetched on demand when the
/// user taps a source on an evolution step.
struct ConversationTranscript: Codable, Identifiable {
    struct Turn: Codable, Identifiable {
        let role: String        // "user" | "assistant"
        let text: String
        let index: Int
        let createdAt: String
        var id: Int { index }
    }
    let conversationId: String
    let source: String
    let sourceUrl: String?
    let messages: [Turn]

    var id: String { conversationId }
    var sourceLabel: String { displaySourceLabel(source) ?? source.capitalized }
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
    /// Operator of this deployment (THREAD_ADMIN_EMAILS) — captures with no cap. Optional so an
    /// older server that doesn't send the field still decodes.
    let isAdmin: Bool?
    let canCapture: Bool        // may this account still capture (Free cap not hit / Pro active)?
    let ideaCount: Int
    let ideaCap: Int            // -1 = no cap (admin)
    let currentPeriodEnd: String?
    let email: String?
    let billingEnabled: Bool     // is Paddle configured on the backend at all?

    var footerLabel: String {
        if isAdmin == true { return "Admin" }
        if !billingEnabled { return "Cloud" }
        if isPro { return status == "canceled" ? "Pro (ending)" : "Pro" }
        return "Free · \(ideaCount)/\(ideaCap)"
    }
}

struct BillingURL: Codable {
    let url: String
}

/// The continuation packet: a compact, source-backed handoff for resuming a thought in any AI
/// tool. `text` is the server's paste-ready render -- copy it verbatim. `packet` is the
/// structured version for the in-app preview (source affordances + an editable next step).
struct ContinueResponse: Codable {
    let text: String
    let packet: ContinuationPacket
    /// "pro" — the server wrote the "continue from here" line with a frontier model.
    /// "free" — the server left the deterministic template there; this Mac sharpens that one
    /// line on-device (Apple Foundation Models) before copying. Absent on older servers.
    let tier: String?
}

struct ContinuationPacket: Codable {
    struct Idea: Codable { let id: String; let title: String; let state: String }
    struct EvolutionStep: Codable, Identifiable {
        let when: String
        let source: String?
        let formulation: String
        let sourceText: String?
        /// Canonical URL of the conversation this step came from -- the "view source" link.
        /// Nil for pastes / pre-URL data. Deliberately absent from the paste-ready `text`.
        let sourceUrl: String?
        var id: String { when + formulation }
    }
    struct PacketDecision: Codable, Identifiable {
        let statement: String
        let decidedAt: String
        var id: String { decidedAt + statement }
    }

    let idea: Idea
    let whereYouLeftOff: String
    let contested: Bool
    /// Verified user-authored steps only (see `evolutionUnverified`). The full list — the paste
    /// text abridges a long one; the preview can show all.
    let evolution: [EvolutionStep]
    /// The idea has history but none of it is a verified user message (pre source-role data).
    /// `evolution` is then empty and the UI says so rather than implying steps are the user's.
    let evolutionUnverified: Bool
    let decisions: [PacketDecision]
    let unresolvedQuestion: String?
    /// Every unresolved loop (newest first, capped) — the machine handoff's UNRESOLVED block.
    /// Absent on older servers.
    var unresolvedQuestions: [String]?
    let suggestedNext: String
    /// The trajectory distilled to one short phrase per verified step. Fills the
    /// {{THINKING_EVOLUTION}} token in `text`. `var` so Free can swap in an on-device version.
    var trajectory: [String]?
    /// One synthesized sentence — "You moved from X toward Y". Nil unless there are ≥2 verified
    /// steps. `var` so the free tier can swap in an on-device version. Absent on older servers.
    var thinkingShift: String?
    /// Where + when this was last worked on, for the "Last explored" line. Absent on older servers.
    var lastExploredSource: String?
    var lastExploredAt: String?

    /// The backend's rendered `text` carries these where the model-written lines go. Fill each
    /// with one literal replace — no client-side re-rendering of the packet.
    static let continueToken = "{{CONTINUE_FROM_HERE}}"
    static let thinkingShiftToken = "{{THINKING_SHIFT}}"
    static let thinkingEvolutionToken = "{{THINKING_EVOLUTION}}"

    /// The distilled steps as a top-down chain, matching the server's `trajectoryChain`.
    var trajectoryChain: String {
        (trajectory ?? []).filter { !$0.isEmpty }.joined(separator: "\n  ↓\n  ")
    }
}

struct APIErrorBody: Codable {
    let error: String?
}
