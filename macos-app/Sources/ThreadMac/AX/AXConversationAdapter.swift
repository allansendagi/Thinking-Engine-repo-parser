import Foundation

/// How sure the adapter is about a block's role. `.inferred` (fell back to turn alternation)
/// drags the whole observation's capture fidelity down to `medium`.
enum AXRoleConfidence {
    case explicit  // a role hint on/near the element said so
    case inferred  // guessed from position in the alternation
}

/// One turn the adapter pulled out of the AX tree. `role` is "user" | "assistant" to match the
/// rest of the app.
struct AXMessageBlock: Equatable {
    let role: String
    let text: String
    let roleConfidence: AXRoleConfidence

    static func == (a: AXMessageBlock, b: AXMessageBlock) -> Bool {
        a.role == b.role && a.text == b.text && a.roleConfidence == b.roleConfidence
    }
}

/// Everything app-specific about reading a conversation out of one native app's AX tree. The
/// generic sensor (`AXConversationSensor`) owns identity, ordering, incremental diffing, the
/// streaming-tail hold, and change detection; an adapter only has to locate the message list and
/// label its turns. "A generic AX sensor that happens to have Cursor as its first adapter."
protocol AXConversationAdapter {
    /// Bundle identifiers this adapter claims. The first is the canonical one.
    static var bundleIDs: [String] { get }

    /// The element whose subtree contains the on-screen message list, or nil if this tree has no
    /// conversation visible right now. Narrowing to this before observing keeps notification noise
    /// (and re-scan cost) down.
    func conversationRoot(appRoot: AXNode) -> AXNode?

    /// The conversation's turns within `root`, oldest first. Empty when nothing message-shaped is
    /// found -- never a partial guess passed off as complete.
    func messageBlocks(root: AXNode) -> [AXMessageBlock]

    /// A key that is stable while the user stays in one chat and changes when they switch to a
    /// different one. nil when it can't be determined (the sensor then holds its current key).
    func conversationKey(root: AXNode, appRoot: AXNode) -> String?
}

// MARK: - Cursor

/// Reads a Cursor chat/composer pane through Accessibility.
///
/// UNVERIFIED against a real Cursor build, on purpose and for the same reason `CursorBackfill` is:
/// Cursor is an Electron app, its AX tree is a bridged DOM, and the exact roles / identifiers /
/// nesting it exposes are undocumented and move between releases. So this matches on a broad set of
/// hints and otherwise falls back to turn alternation, and it degrades to "found nothing" rather
/// than emitting a confident wrong answer. The generic sensor's provisional/committed handling and
/// the `medium` fidelity stamp on inferred roles are what make that safe.
struct CursorAXAdapter: AXConversationAdapter {
    static let bundleIDs = ["com.todesktop.230313mzl4w4u92"]

    /// Container roles a chat list plausibly lives in.
    private let containerRoles: Set<String> = ["AXScrollArea", "AXGroup", "AXWebArea", "AXList"]
    /// Roles a single rendered turn plausibly is.
    private let blockRoles: Set<String> = ["AXGroup", "AXStaticText", "AXTextArea", "AXWebArea", "AXCell"]

    private let userHints = ["user", "human", "you said", "your message", "prompt"]
    private let assistantHints = ["assistant", "ai ", "ai:", "ai response", "response", "bot", "model", "cursor", "markdown"]
    private let chatContainerHints = ["chat", "composer", "aichat", "conversation", "messages", "thread"]

    func conversationRoot(appRoot: AXNode) -> AXNode? {
        let all = appRoot.flattened()

        // First choice: a container whose own hints name it as the chat pane. One block is enough
        // here -- a named container plus a message-shaped child is unambiguous, and it lets a
        // conversation with a single turn so far (asked, not yet answered) be captured.
        let named = all.first { node in
            containerRoles.contains(node.axRole)
                && chatContainerHints.contains { node.axHints.contains($0) }
                && !blocks(in: node).isEmpty
        }
        if let named { return named }

        // Otherwise: the container that yields the most message-shaped blocks (shallowest on a tie
        // so we get the whole list, not one turn's inner group). Needs at least two -- without a
        // name, one stray text block in a group is not enough to call it a conversation.
        var best: (node: AXNode, count: Int)?
        for node in all where containerRoles.contains(node.axRole) {
            let c = blocks(in: node).count
            if c >= 2, best == nil || c > best!.count { best = (node, c) }
        }
        return best?.node
    }

    func messageBlocks(root: AXNode) -> [AXMessageBlock] {
        let raw = blocks(in: root)
        return raw.enumerated().map { index, block in
            if let explicit = explicitRole(for: block) {
                return AXMessageBlock(role: explicit, text: block.text, roleConfidence: .explicit)
            }
            // Cursor conversations open with a user turn; alternate from there.
            return AXMessageBlock(
                role: index.isMultiple(of: 2) ? "user" : "assistant",
                text: block.text,
                roleConfidence: .inferred
            )
        }
    }

    func conversationKey(root: AXNode, appRoot _: AXNode) -> String? {
        // Prefer a handle that does NOT move when the message list virtualizes: the pane's own
        // identifier, else its title. Only if neither exists, fall back to hashing the first
        // visible turn -- and that fallback genuinely shifts when the top of the transcript
        // scrolls out of the AX tree, which the sensor would read as a conversation switch.
        if let id = root.axIdentifier?.trimmingCharacters(in: .whitespaces), id.count > 3 {
            return AXText.shortHash(id)
        }
        if let title = root.axTitle?.trimmingCharacters(in: .whitespaces), !title.isEmpty {
            return AXText.shortHash(title)
        }
        let blocks = self.blocks(in: root)
        guard let first = blocks.first?.text, !first.isEmpty else { return nil }
        return AXText.shortHash(AXText.normalize(first))
    }

    // MARK: heuristic block extraction

    /// A candidate turn: `axText` present and non-trivial, a plausible block role, and NOT already
    /// contained in a chosen ancestor (take the outermost coherent block, skip its inner text).
    ///
    /// `hints` for a block is its own identity attributes PLUS every ancestor's, joined -- Cursor
    /// (Electron) hangs the role hint on a wrapper `AXGroup` while the text lives on a nested
    /// `AXStaticText`, so a leaf-only read would miss every role.
    private func blocks(in root: AXNode) -> [(node: AXNode, text: String, hints: String)] {
        var out: [(node: AXNode, text: String, hints: String)] = []
        var cutoff = -1

        // Pre-order walk carrying accumulated ancestor hints. Push children reversed so LIFO
        // yields natural order.
        var ordered: [(node: AXNode, depth: Int, hints: String)] = []
        var stack: [(node: AXNode, depth: Int, hints: String)] = [(root, 0, root.axHints)]
        while let (n, d, h) = stack.popLast() {
            ordered.append((n, d, h))
            for c in n.axChildren.reversed() {
                let merged = h.isEmpty ? c.axHints : (h + " " + c.axHints)
                stack.append((c, d + 1, merged))
            }
        }

        for (node, depth, hints) in ordered {
            if cutoff >= 0, depth > cutoff { continue }
            cutoff = -1
            guard blockRoles.contains(node.axRole), let text = node.axText else { continue }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            let substantial = trimmed.count >= 12 || trimmed.contains(" ")
            let hinted = !hintRole(hints).isEmpty
            guard !trimmed.isEmpty, substantial || hinted else { continue }
            out.append((node, trimmed, hints))
            cutoff = depth  // skip this block's descendants
        }
        return out
    }

    private func explicitRole(for block: (node: AXNode, text: String, hints: String)) -> String? {
        let r = hintRole(block.hints)
        return r.isEmpty ? nil : r
    }

    private func hintRole(_ hints: String) -> String {
        if userHints.contains(where: hints.contains) { return "user" }
        if assistantHints.contains(where: hints.contains) { return "assistant" }
        return ""
    }
}
