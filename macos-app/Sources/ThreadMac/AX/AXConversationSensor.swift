import Foundation

/// One turn the sensor has decided is stable and ready to send.
struct AXSettledMessage: Equatable {
    let id: String
    let role: String       // "user" | "assistant"
    let text: String       // normalized
    /// "high" when the adapter knew the role; "medium" when it fell back to alternation.
    let fidelity: String
}

/// The result of reducing one AX-tree observation against prior state.
struct AXSensorStep: Equatable {
    /// Set when this observation belongs to a different conversation than the last one -- the
    /// caller should start a fresh backend `conversationId`.
    var conversationChangedTo: String?
    /// Turns that settled this round, in transcript order, none seen before.
    var settled: [AXSettledMessage]
    /// True when the trailing assistant turn is being withheld because its text is still moving.
    /// Purely informational (a harness/telemetry signal); it is not an error.
    var holdingStreamingTail: Bool
}

/// Per-conversation accumulator the sensor carries between observations. In-memory only: a restart
/// replays whatever is on screen once, and the backend -- which dedupes on message id -- absorbs
/// the repeat.
struct AXSensorState {
    var conversationKey: String?
    var emittedIDs: Set<String> = []
    var pendingTailText: String?
    var pendingTailSince: Date = .distantPast
}

/// One observation: the adapter's key + blocks for the tree as it looks right now.
struct AXConversationObservation: Equatable {
    let conversationKey: String
    let blocks: [AXMessageBlock]
}

/// The generic core. Everything app-specific is in the adapter; everything time- or
/// API-dependent is in the runner. This part is pure: `step` is a function of (observation, now,
/// prior state) and is what the CI tests exercise.
///
/// "Probabilistic capture, deterministic state": a turn is emitted only once it is stable. The
/// trailing assistant turn -- the one that streams token by token -- is held back until its text
/// has stopped changing for `settleInterval`. Earlier turns are settled by the plain fact that a
/// later turn exists after them.
enum AXConversationSensor {
    static let defaultSettleInterval: TimeInterval = 0.8

    static func step(
        observation: AXConversationObservation,
        now: Date,
        settleInterval: TimeInterval = defaultSettleInterval,
        state: inout AXSensorState
    ) -> AXSensorStep {
        var out = AXSensorStep(conversationChangedTo: nil, settled: [], holdingStreamingTail: false)

        if state.conversationKey != observation.conversationKey {
            state.conversationKey = observation.conversationKey
            state.emittedIDs.removeAll()
            state.pendingTailText = nil
            state.pendingTailSince = .distantPast
            out.conversationChangedTo = observation.conversationKey
        }

        let key = observation.conversationKey
        let blocks = observation.blocks
        guard !blocks.isEmpty else { return out }

        // Decide how many trailing blocks are settled. Default: all of them. If the last block is
        // an assistant turn, hold it until its normalized text has been identical across at least
        // `settleInterval`. A trailing user turn does not stream -- settle it immediately.
        var settleableCount = blocks.count
        if let last = blocks.last, last.role == "assistant" {
            let norm = AXText.normalize(last.text)
            if state.pendingTailText != norm {
                state.pendingTailText = norm
                state.pendingTailSince = now
                settleableCount = blocks.count - 1
                out.holdingStreamingTail = true
            } else if now.timeIntervalSince(state.pendingTailSince) < settleInterval {
                settleableCount = blocks.count - 1
                out.holdingStreamingTail = true
            }
        }

        for block in blocks.prefix(max(0, settleableCount)) {
            let norm = AXText.normalize(block.text)
            guard norm.count >= 2 else { continue }
            let id = AXText.messageID(conversationKey: key, role: block.role, text: norm)
            guard !state.emittedIDs.contains(id) else { continue }
            state.emittedIDs.insert(id)
            out.settled.append(AXSettledMessage(
                id: id,
                role: block.role,
                text: norm,
                fidelity: block.roleConfidence == .inferred ? "medium" : "high"
            ))
        }
        return out
    }

    /// The one fidelity stamp for a batch of settled messages: `medium` if any turn's role was
    /// only inferred, else `high`.
    static func batchFidelity(_ messages: [AXSettledMessage]) -> String {
        messages.contains { $0.fidelity == "medium" } ? "medium" : "high"
    }
}
