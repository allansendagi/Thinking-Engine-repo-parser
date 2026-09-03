import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

/// Apple's on-device language model (Foundation Models, macOS 26+), used for the one
/// model-written line in a continuation packet — "Continue from here". A Free account gets a
/// sharp, paste-ready next step with no server call and no per-use cost; Pro routes that same
/// line through a frontier model on the server for maximum quality.
///
/// Every path degrades safely and silently: no framework (older SDK, or the macOS 15 CI
/// runner), the model not present (Intel Mac, Apple Intelligence off, still downloading), or a
/// failed generation all return `nil` / `isReady == false`, and the caller keeps the
/// deterministic template line the server already provided.
enum OnDeviceModel {

    struct Status {
        var isReady: Bool
        /// A short, user-facing reason when not ready; `nil` when ready.
        var reason: String?
    }

    static var status: Status {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return Status(isReady: true, reason: nil)
            case .unavailable(let why):
                return Status(isReady: false, reason: describe(why))
            @unknown default:
                return Status(isReady: false, reason: "Apple Intelligence is unavailable")
            }
        }
        #endif
        return Status(isReady: false, reason: "Needs macOS 26 with Apple Intelligence")
    }

    /// One sentence the user can paste into a fresh chat to pick the thought back up — their
    /// voice, grounded only in what's passed. Returns `nil` if the model isn't ready or the
    /// call fails; the caller then keeps its template line.
    static func continueFromHere(
        whereYouLeftOff: String,
        evolution: [String],
        unresolvedQuestion: String?,
        contested: Bool
    ) async -> String? {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *), case .available = SystemLanguageModel.default.availability {
            let facts = """
            Where they left off: \(whereYouLeftOff)
            How it evolved: \(evolution.isEmpty ? "(not recorded)" : evolution.joined(separator: " → "))
            Unresolved question: \(unresolvedQuestion ?? "(none)")
            Contested: \(contested ? "yes — a later point conflicts with an earlier one" : "no")
            """
            do {
                let session = LanguageModelSession(instructions: Self.instructions)
                let raw = try await session.respond(to: facts).content
                let one = firstSentence(raw.trimmingCharacters(in: .whitespacesAndNewlines))
                return one.isEmpty ? nil : one
            } catch {
                return nil
            }
        }
        #endif
        return nil
    }

    /// A fast, local read of what a freshly captured transcript is *about* — enough to show a
    /// real card the instant it's captured, before the backend's full extraction pipeline runs.
    /// The backend stays the authority on the durable idea graph (identity, evolution); this is
    /// the optimistic preview. Returns `nil` when the on-device model isn't available.
    static func extractIdea(from transcript: String) async -> LocalIdeaDraft? {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *), case .available = SystemLanguageModel.default.availability {
            let clipped = String(transcript.prefix(6000))
            do {
                let session = LanguageModelSession(instructions: Self.extractInstructions)
                let raw = try await session.respond(to: clipped).content
                return LocalIdeaDraft.parse(raw)
            } catch {
                return nil
            }
        }
        #endif
        return nil
    }

    /// One capture folded into the local graph: whether it continues an existing idea or starts
    /// a new one, plus the idea's fields. `target` is `"new"` or an existing idea id.
    struct GraphDelta: Codable, Equatable {
        var target: String
        var title: String
        var formulation: String
        var state: String
        var openQuestion: String?

        var draft: LocalIdeaDraft {
            LocalIdeaDraft(
                title: title,
                formulation: formulation.isEmpty ? title : formulation,
                state: LocalIdeaDraft.allowedStates.contains(state) ? state : "developing",
                openQuestion: (openQuestion?.isEmpty ?? true) ? nil : openQuestion
            )
        }
    }

    /// Extraction + identity in one on-device pass: given a capture and the ideas already in the
    /// local graph, decide which (if any) it extends and return the merged fields. Returns nil
    /// when the model isn't available; the caller then treats the capture as a new idea from
    /// `extractIdea`.
    static func absorbCapture(text: String, existing: [(id: String, title: String)]) async -> GraphDelta? {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *), case .available = SystemLanguageModel.default.availability {
            let clipped = String(text.prefix(6000))
            let list = existing.isEmpty
                ? "(none yet)"
                : existing.map { "[\($0.id)] \($0.title)" }.joined(separator: "\n")
            let prompt = """
            EXISTING IDEAS:
            \(list)

            NEW CAPTURE:
            \(clipped)
            """
            do {
                let session = LanguageModelSession(instructions: Self.absorbInstructions)
                let raw = try await session.respond(to: prompt).content
                guard let delta = GraphDelta.parse(raw) else { return nil }
                let validTargets = Set(existing.map(\.id))
                return validTargets.contains(delta.target) ? delta : GraphDelta(
                    target: "new", title: delta.title, formulation: delta.formulation,
                    state: delta.state, openQuestion: delta.openQuestion
                )
            } catch {
                return nil
            }
        }
        #endif
        return nil
    }

    private static let absorbInstructions = """
    You maintain someone's idea graph. Given a new capture of them thinking with an AI, and the \
    ideas already in the graph, decide whether the capture CONTINUES one existing idea or starts \
    a NEW one, and give that idea's current fields. Reply with ONLY a JSON object:
    {"target": "the existing idea's id if this continues it, otherwise \\"new\\"", \
    "title": "at most 8 words, the thought in their own voice — never \\"the user…\\"", \
    "formulation": "one declarative sentence for where the idea now stands", \
    "state": "developing | established | contested | rejected", \
    "openQuestion": "the one unresolved question if there is a clear one, otherwise null"}
    Only pick an existing id when it is genuinely the same line of thinking. When unsure, "new".
    """

    private static let extractInstructions = """
    From this transcript of someone thinking with an AI, identify the SINGLE main idea the \
    PERSON (not the AI) is developing. Reply with ONLY a JSON object, no other text:
    {"title": "at most 8 words, the thought itself in their own voice — never \\"the user…\\"", \
    "formulation": "one declarative sentence stating where the idea now stands", \
    "state": "developing | established | contested | rejected", \
    "openQuestion": "the one unresolved question if there is a clear one, otherwise null"}
    If the transcript holds no real idea of the person's own, reply {"title": null}.
    """

    /// Mirrors the server's `NEXT_STEP_PROMPT` (src/mcp/tools.ts) so Free and Pro produce the
    /// same shape of line — one paste-ready instruction in the user's own voice.
    private static let instructions = """
    You are given a line of thinking a user developed with AI. Write ONE sentence they can \
    paste into a new AI chat to pick it back up: an instruction in their own voice, grounded \
    only in what's given, pointing at the unresolved question if there is one. No preamble, \
    no "you should", one sentence.
    """

    #if canImport(FoundationModels)
    @available(macOS 26.0, *)
    private static func describe(_ why: SystemLanguageModel.Availability.UnavailableReason) -> String {
        switch why {
        case .deviceNotEligible:
            return "This Mac isn't eligible for Apple Intelligence"
        case .appleIntelligenceNotEnabled:
            return "Turn on Apple Intelligence in System Settings"
        case .modelNotReady:
            return "Apple Intelligence is still downloading its model"
        @unknown default:
            return "Apple Intelligence is unavailable"
        }
    }
    #endif

    /// Keep only the first sentence — the model is told to give one, this enforces it.
    private static func firstSentence(_ s: String) -> String {
        guard let r = s.range(of: #"[.!?](\s|$)"#, options: .regularExpression) else { return s }
        return String(s[..<r.upperBound]).trimmingCharacters(in: .whitespaces)
    }
}

/// Which engine wrote the "Continue from here" line in the current handoff — drives a quiet
/// caption in the preview so the user knows whether it was drafted locally or by the server.
enum ContinuationEngine {
    case none, onDevice, template, frontier

    var hint: String? {
        switch self {
        case .none, .template: return nil
        case .onDevice:        return "Drafted on this Mac"
        case .frontier:        return "Drafted by Claude"
        }
    }
}
