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
