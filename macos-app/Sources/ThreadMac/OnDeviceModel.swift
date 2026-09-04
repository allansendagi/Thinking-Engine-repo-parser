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
                return looksUnusable(one) ? nil : one
            } catch {
                return nil
            }
        }
        #endif
        return nil
    }

    /// One sentence naming how a line of thinking shifted between its first and current form —
    /// "You moved from … toward …". Returns nil if the model isn't ready, the call fails, or the
    /// output doesn't land in that shape; the caller then keeps the server's literal template.
    static func thinkingShift(from first: String, to latest: String) async -> String? {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *), case .available = SystemLanguageModel.default.availability {
            do {
                let session = LanguageModelSession(instructions: Self.shiftInstructions)
                let raw = try await session.respond(to: "First: \(first)\nCurrent: \(latest)").content
                let one = firstSentence(raw.trimmingCharacters(in: .whitespacesAndNewlines))
                return one.lowercased().hasPrefix("you moved from") && !looksUnusable(one) ? one : nil
            } catch {
                return nil
            }
        }
        #endif
        return nil
    }

    private static let shiftInstructions = """
    You're given the first and current version of one line of a person's thinking. In ONE \
    sentence beginning "You moved from", name the conceptual shift between them — the change in \
    position, not a reword. No preamble, no hedging, one sentence.
    """

    /// The trajectory distilled: one phrase of ≤6 words per formulation, same order. Returns nil
    /// unless the model is ready and the line count matches the input; the caller then keeps the
    /// server's first-words template.
    static func trajectory(formulations: [String]) async -> [String]? {
        guard formulations.count >= 2 else { return nil }
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *), case .available = SystemLanguageModel.default.availability {
            let numbered = formulations.enumerated().map { "\($0.offset + 1). \($0.element)" }.joined(separator: "\n")
            do {
                let session = LanguageModelSession(instructions: Self.trajectoryInstructions)
                let raw = try await session.respond(to: numbered).content
                let lines = raw.split(separator: "\n").map {
                    $0.trimmingCharacters(in: CharacterSet(charactersIn: " \t-•*0123456789.)"))
                }.filter { !$0.isEmpty }
                // Reject unless it actually distilled — a small model sometimes echoes the input.
                let distilled = lines.count == formulations.count
                    && lines.allSatisfy { $0.split(separator: " ").count <= 7 && $0.count <= 60 && !looksUnusable($0) }
                return distilled ? lines : nil
            } catch {
                return nil
            }
        }
        #endif
        return nil
    }

    private static let trajectoryInstructions = """
    Distil each numbered formulation to a headline of AT MOST 5 words — the core move, not a \
    summary, never the sentence itself. Output ONLY the headlines, one per line, same count and \
    order, nothing else. Example: "AI governance needs better oversight policies." becomes \
    "governance by written policy".
    """

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
    You are given a line of thinking a person developed with AI. Write ONE sentence they can \
    paste into a new AI chat to pick it back up — an instruction in their own voice, grounded \
    only in what's given. If there is an unresolved question, point at it; if not, push the \
    current formulation forward, or resolve the conflict if it's contested. Always produce a \
    usable sentence — never refuse, never mention being an AI or a model. No preamble, no \
    "you should", one sentence.
    """

    /// A model that won't answer — a canned refusal or meta-commentary. Never show it to the
    /// user; the caller falls back to the deterministic template.
    static func looksUnusable(_ s: String) -> Bool {
        let t = s.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return true }
        let openers = [
            "i'm sorry", "i am sorry", "i cannot", "i can't", "i can not", "i'm unable",
            "i am unable", "i'm not able", "i am not able", "i apologize", "as an ai",
            "as a chatbot", "as a language model", "unfortunately, i", "sorry, ",
        ]
        if openers.contains(where: { t.hasPrefix($0) }) { return true }
        let anywhere = [
            "as a chatbot", "as an ai language model", "created by apple", "i cannot provide",
            "i'm unable to provide", "i am unable to provide", "cannot fulfill", "cannot fulfil",
            "against my guidelines", "when none exists", "no unresolved question exists",
        ]
        return anywhere.contains(where: { t.contains($0) })
    }

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

// MARK: - Governing thought (Minto synthesis across related ideas, self-consistency gated)
//
// STATUS: dormant research, not activated. Nothing in AppState or any view calls
// governingThought(_:_:) below -- production governing-thought synthesis is 100% the server path
// (src/mcp/tools.ts buildGoverningThought, PR #29: candidate retrieval -> strong reasoning model
// -> deterministic validation -> persist). Why: this isn't disposable prose, it becomes part of
// what Continue tells someone their own thinking is -- a false "these ideas are related" doesn't
// just read badly, it corrupts that record. Probabilistic intelligence, deterministic authority:
// the strong model clears the bar for that today (see GoverningThoughtBenchmark.swift's history
// for the actual numbers); on-device doesn't yet. Kept, tested, and benchmarked as the upgrade
// path for whenever a future Apple model does.
//
// The server has its own version of this (src/mcp/tools.ts, buildGoverningThought / PR #29) —
// this is NOT that ported to Swift wholesale. It's specifically the piece the benchmark
// (macos-app/Tests/ThreadMacTests/GoverningThoughtBenchmark.swift, kept local/uncommitted so it
// can be re-run against every future Apple model) showed was worth building on-device: given a
// small, already-retrieved candidate set, decide whether it's one coherent argument and
// synthesize it. Candidate retrieval itself stays server-side/deterministic elsewhere; this
// function takes candidates as input, it doesn't find them.
//
// What the benchmark found, and why this function is shaped the way it is:
//   - A single on-device call's raw coherence accuracy was ~56% (10/18) -- real, but not
//     reliable enough to trust unattended near Thread's actual state.
//   - Asking the model to also self-report a confidence field measurably HURT accuracy (56% ->
//     33%), and the confidence value itself didn't correlate with correctness. Not a usable
//     signal -- this never asks for one.
//   - Calling 3 independent times and checking STRUCTURAL agreement (same coherent flag, same
//     selected candidate indexes -- never the governing-thought wording, which varies harmlessly
//     run to run) predicted correctness well: 86% right when unanimous (6/7) vs. 60% when split
//     (6/10). But voting the 3 answers into one did NOT beat a single call (majority-vote
//     accuracy did not exceed single-call accuracy) -- agreement is an ACCEPT/REJECT gate, never
//     a way to resolve a disagreement into an answer.
//   - Deterministic validation (JSON shape, index range, uniqueness, non-empty required fields)
//     held 18/18 across every round -- the model's output SHAPE is trustworthy even when its
//     judgment isn't, so that half of the gate is enforced in full, unconditionally.
//
// Net: 3 calls, structural agreement only (no voting), full deterministic validation, and a
// split vote returns `.uncertain` rather than ever resolving itself -- the model never gets
// authority to decide Thread's state on a disagreement. Nothing currently escalates `.uncertain`
// to the server (no on-device caller exists yet that would); it's returned distinctly, and
// logged distinctly, so a future caller can, without this function's contract changing.

/// One candidate idea offered to the classifier. `id` is the app's real idea id; the model only
/// ever sees a 1-based slot number (mirrors the server's numbered-candidate protocol), never the
/// id itself.
struct GoverningThoughtCandidate {
    let id: String
    let formulation: String
}

struct GoverningThoughtResult: Equatable {
    var statement: String
    var kind: String
    var memberIds: [String]
}

enum GoverningThoughtOutcome: Equatable {
    /// All 3 calls structurally agreed on a real, validated cluster.
    case found(GoverningThoughtResult)
    /// All 3 calls agreed there's no coherent cluster here -- confidently nothing, not a reason
    /// to ask anything else.
    case confidentlyNone
    /// The 3 calls disagreed, or one produced unusable output -- a real signal (see above), not
    /// treated as either "yes" or "no". This is where a future caller could escalate to the
    /// server's reasoning pass.
    case uncertain
    /// Never attempted: the model isn't available (older macOS, Apple Intelligence off), or
    /// there were no candidates to evaluate. Not counted as a local_attempts run.
    case unavailable
}

/// One on-device run's decision. Mirrors src/mcp/tools.ts's GoverningThoughtDecision /
/// parseGoverningThoughtResponse: same JSON shape, same validation bounds (statement <= 240
/// chars, kind <= 4 words / 40 chars, refusal-shape rejection via OnDeviceModel.looksUnusable) --
/// a result this trusts is held to the identical bar the server enforces server-side.
struct GoverningThoughtDecision: Equatable {
    var coherent: Bool
    var statement: String
    var kind: String
    var supportingIndexes: [Int]

    /// nil on anything unparseable or refusal-shaped. A clean `coherent: false` is NOT nil --
    /// it's a real, valid decision, returned as `.coherent = false` with empty content (stray
    /// content alongside a false answer is deliberately ignored, never validated or trusted).
    static func parse(_ raw: String, candidateCount: Int) -> GoverningThoughtDecision? {
        guard let start = raw.firstIndex(of: "{"), let end = raw.lastIndex(of: "}"), start < end else { return nil }
        guard let data = String(raw[start...end]).data(using: .utf8) else { return nil }
        struct Wire: Decodable {
            var coherent: Bool?
            var governingThought: String?
            var groupType: String?
            var supportingIdeaIds: [Int]?
        }
        guard let w = try? JSONDecoder().decode(Wire.self, from: data) else { return nil }
        guard w.coherent == true else {
            return GoverningThoughtDecision(coherent: false, statement: "", kind: "", supportingIndexes: [])
        }
        let statement = (w.governingThought ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let kind = (w.groupType ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !statement.isEmpty, !kind.isEmpty else { return nil }
        guard !OnDeviceModel.looksUnusable(statement), !OnDeviceModel.looksUnusable(kind) else { return nil }
        guard statement.count <= 240 else { return nil }
        guard kind.split(separator: " ").count <= 4, kind.count <= 40 else { return nil }
        let indexes = Array(Set((w.supportingIdeaIds ?? []).filter { $0 >= 1 && $0 <= candidateCount })).sorted()
        guard !indexes.isEmpty else { return nil }
        return GoverningThoughtDecision(coherent: true, statement: statement, kind: kind, supportingIndexes: indexes)
    }
}

extension OnDeviceModel {
    static let governingThoughtMaxCandidates = 4

    /// Governing-thought synthesis, gated on self-consistency across 3 independent calls. See
    /// the module doc above for what the benchmark found and why this is shaped this way.
    static func governingThought(
        currentThought: String,
        candidates: [GoverningThoughtCandidate]
    ) async -> GoverningThoughtOutcome {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *), case .available = SystemLanguageModel.default.availability, !candidates.isEmpty {
            let capped = Array(candidates.prefix(Self.governingThoughtMaxCandidates))
            let facts = Self.governingThoughtFacts(currentThought: currentThought, candidates: capped)

            var runs: [GoverningThoughtDecision] = []
            for _ in 0..<3 {
                do {
                    let session = LanguageModelSession(instructions: Self.governingThoughtInstructions)
                    let raw = try await session.respond(to: facts).content
                    guard let decision = GoverningThoughtDecision.parse(raw, candidateCount: capped.count) else {
                        Self.logGoverningThought(agreed: false, accepted: false, outcome: "unparseable")
                        return .uncertain
                    }
                    runs.append(decision)
                } catch {
                    Self.logGoverningThought(agreed: false, accepted: false, outcome: "call-failed")
                    return .uncertain
                }
            }

            let outcome = Self.structuralAgreement(runs, candidates: capped)
            switch outcome {
            case .found: Self.logGoverningThought(agreed: true, accepted: true, outcome: "found")
            case .confidentlyNone: Self.logGoverningThought(agreed: true, accepted: false, outcome: "confidently-none")
            case .uncertain: Self.logGoverningThought(agreed: false, accepted: false, outcome: "uncertain")
            case .unavailable: break // structuralAgreement never returns this
            }
            return outcome
        }
        #endif
        return .unavailable
    }

    /// Pure and independently testable (no live model call): given 3 decisions and the candidate
    /// list they were judged against, decide the outcome. This is the "structural-agreement
    /// evaluator" -- the only place a disagreement is decided, and it never resolves one, only
    /// detects it.
    static func structuralAgreement(
        _ runs: [GoverningThoughtDecision],
        candidates: [GoverningThoughtCandidate]
    ) -> GoverningThoughtOutcome {
        guard runs.count == 3 else { return .uncertain }

        guard Set(runs.map(\.coherent)).count == 1 else { return .uncertain }
        guard runs[0].coherent else { return .confidentlyNone }

        let idSets = Set(runs.map { Set($0.supportingIndexes) })
        guard idSets.count == 1, let indexes = idSets.first, !indexes.isEmpty else { return .uncertain }

        let members = indexes.sorted().compactMap { i -> GoverningThoughtCandidate? in
            candidates.indices.contains(i - 1) ? candidates[i - 1] : nil
        }
        guard members.count == indexes.count else { return .uncertain } // shouldn't happen; never trust a mismatch

        let agreed = runs[0] // any of the 3 -- they structurally agree; wording differences are fine
        return .found(GoverningThoughtResult(statement: agreed.statement, kind: agreed.kind, memberIds: members.map(\.id)))
    }

    /// .prettyPrinted matters, not just cosmetics: it's what the self-consistency benchmark that
    /// justified shipping this actually measured against (86%/60%). Compact JSON is untested --
    /// don't drop this flag without re-running the benchmark against whatever replaces it.
    private static func governingThoughtFacts(currentThought: String, candidates: [GoverningThoughtCandidate]) -> String {
        let items = candidates.enumerated().map { i, c -> [String: Any] in ["id": i + 1, "formulation": c.formulation] }
        let obj: [String: Any] = ["currentThought": currentThought, "otherIdeas": items]
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]),
              let s = String(data: data, encoding: .utf8)
        else { return currentThought } // shouldn't happen -- plain strings only
        return s
    }

    /// Console-only instrumentation: how often the local path resolves vs. would need
    /// escalation, measurable in real use, not just in the benchmark. No idea content leaves the
    /// device or this line -- only counts and an outcome label.
    private static func logGoverningThought(agreed: Bool, accepted: Bool, outcome: String) {
        print("[Thread][governing-thought] local_attempts=1 local_agreement=\(agreed) local_accept=\(accepted) cloud_escalation=\(!agreed) local_result=\(outcome)")
    }

    /// On-device-tuned (NOT the server's verbatim prompt -- the benchmark found the server's
    /// caution framing, "a wrong synthesis is worse than none", measurably suppressed true
    /// positives on this model). Keep in sync by hand with the server's GOVERNING_THOUGHT_PROMPT
    /// lineage (src/mcp/tools.ts) only in spirit, not text -- they're allowed to diverge because
    /// they're tuned for different models.
    private static let governingThoughtInstructions = """
    You are given a person's current line of thinking, and up to 4 other ideas from their thinking graph (numbered 1-4) that were retrieved because they read similarly.

    Determine whether one or more of these other ideas form a coherent group with the current thought -- genuinely continuing the same line of thinking, as a reason, consequence, step, example, or a direct challenge to it. Not merely sharing vocabulary, and not just restating the current thought in different words. Base your answer only on what the ideas actually say -- never invent a relationship they don't support.

    If they do form a coherent group, identify the governing thought -- one sentence for what the current thought and its genuine supporters collectively mean -- and select only the ideas that genuinely support it, dropping any that are unrelated or that just restate the current thought.

    Reply with ONLY a JSON object, no other text:
    {"coherent": true or false,
     "governingThought": "the governing thought, one sentence. Present only when coherent is true.",
     "groupType": "a plural noun naming what the supporting ideas ARE in relation to the governing thought -- e.g. reasons, objections, consequences, examples, preconditions, constraints, steps. Present only when coherent is true.",
     "supportingIdeaIds": "the numbers of ONLY the ideas that genuinely support the governing thought. Present only when coherent is true."}

    Never mention being an AI or a model.
    """
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
