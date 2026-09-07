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
/// label its turns. Adding a native AI app is a new adapter, never an engine change.
protocol AXConversationAdapter {
    /// Bundle identifiers this adapter claims. The first is the canonical one.
    var bundleIDs: [String] { get }
    /// The `Source` raw value for captures from this app -- "cursor" | "claude" | "chatgpt".
    /// Also the per-app key in capture health, so one app's adapter breaking is visible on its own.
    var source: String { get }

    /// The element whose subtree contains the on-screen message list, or nil if this tree has no
    /// conversation visible right now.
    func conversationRoot(appRoot: AXNode) -> AXNode?

    /// The conversation's turns within `root`, oldest first. Empty when nothing message-shaped is
    /// found -- never a partial guess passed off as complete.
    func messageBlocks(root: AXNode) -> [AXMessageBlock]

    /// A key that is stable while the user stays in one chat and changes when they switch to a
    /// different one. nil when it can't be determined (the sensor then holds its current key).
    func conversationKey(root: AXNode, appRoot: AXNode) -> String?

    /// The message-composer element, for native continuation (writing a checkpoint back in). nil
    /// when it can't be found. Optional -- default is nil.
    func composerElement(appRoot: AXNode) -> AXNode?
}

extension AXConversationAdapter {
    func composerElement(appRoot: AXNode) -> AXNode? { nil }
}

// MARK: - config-driven heuristic adapter

/// The hint sets that make one `HeuristicAXAdapter` behave as the Cursor / Claude / ChatGPT
/// adapter. Everything else -- tree walk, ancestor-hint propagation, block extraction, the
/// alternation fallback, the virtualization-safe conversation key -- is shared.
struct AXAdapterConfig {
    let bundleIDs: [String]
    let source: String
    var userHints: [String]
    var assistantHints: [String]
    var chatContainerHints: [String]
    var composerHints: [String] = [
        "composer", "message", "send a message", "reply", "ask", "prompt", "type a message", "chat input",
    ]
    var containerRoles: Set<String> = ["AXScrollArea", "AXGroup", "AXWebArea", "AXList"]
    var blockRoles: Set<String> = ["AXGroup", "AXStaticText", "AXTextArea", "AXWebArea", "AXCell"]
    var composerRoles: Set<String> = ["AXTextArea", "AXTextField"]

    static let cursor = AXAdapterConfig(
        bundleIDs: ["com.todesktop.230313mzl4w4u92"],
        source: "cursor",
        userHints: ["user", "human", "you said", "your message", "prompt"],
        assistantHints: ["assistant", "ai ", "ai:", "ai response", "response", "bot", "model", "cursor", "markdown"],
        chatContainerHints: ["chat", "composer", "aichat", "conversation", "messages", "thread"]
    )

    static let claude = AXAdapterConfig(
        bundleIDs: ["com.anthropic.claudefordesktop", "com.anthropic.claude"],
        source: "claude",
        userHints: ["user", "human", "you said", "your message"],
        assistantHints: ["assistant", "claude", "claude responded", "ai response", "response", "model"],
        chatContainerHints: ["chat", "conversation", "messages", "thread"]
    )

    static let chatgpt = AXAdapterConfig(
        bundleIDs: ["com.openai.chat"],
        source: "chatgpt",
        userHints: ["user", "you said", "your message"],
        assistantHints: ["assistant", "chatgpt", "chatgpt said", "gpt", "ai response", "response"],
        chatContainerHints: ["chat", "conversation", "messages", "thread"]
    )
}

/// Reads a native AI app's chat pane through Accessibility, driven by `AXAdapterConfig`.
///
/// UNVERIFIED against every one of these apps, on purpose and for the same reason `CursorBackfill`
/// is: they are Electron / web-view apps, their AX trees are bridged DOM, and the exact roles /
/// identifiers / nesting are undocumented and move between releases. So this matches on a broad
/// set of hints and otherwise falls back to turn alternation, and it degrades to "found nothing"
/// rather than a confident wrong answer. The generic sensor's provisional/committed handling and
/// the `medium` fidelity stamp on inferred roles are what make that safe. Tune the hint sets
/// against a real AX-tree dump (THREAD_AX_DUMP=1).
struct HeuristicAXAdapter: AXConversationAdapter {
    let config: AXAdapterConfig

    var bundleIDs: [String] { config.bundleIDs }
    var source: String { config.source }

    func conversationRoot(appRoot: AXNode) -> AXNode? {
        let all = appRoot.flattened()

        // First choice: a container whose own hints name it as the chat pane. One block is enough
        // -- a named container plus a message-shaped child is unambiguous, and it lets a
        // conversation with a single turn so far be captured.
        let named = all.first { node in
            config.containerRoles.contains(node.axRole)
                && config.chatContainerHints.contains { node.axHints.contains($0) }
                && !blocks(in: node).isEmpty
        }
        if let named { return named }

        // Otherwise: the container that yields the most message-shaped blocks (shallowest on a
        // tie so we get the whole list, not one turn's inner group). Needs at least two.
        var best: (node: AXNode, count: Int)?
        for node in all where config.containerRoles.contains(node.axRole) {
            let c = blocks(in: node).count
            if c >= 2, best == nil || c > best!.count { best = (node, c) }
        }
        return best?.node
    }

    func messageBlocks(root: AXNode) -> [AXMessageBlock] {
        blocks(in: root).enumerated().map { index, block in
            if let explicit = hintRoleOrNil(block.hints) {
                return AXMessageBlock(role: explicit, text: block.text, roleConfidence: .explicit)
            }
            // These conversations open with a user turn; alternate from there.
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
        // visible turn -- which genuinely shifts when the top of the transcript scrolls out.
        if let id = root.axIdentifier?.trimmingCharacters(in: .whitespaces), id.count > 3 {
            return AXText.shortHash(id)
        }
        if let title = root.axTitle?.trimmingCharacters(in: .whitespaces), !title.isEmpty {
            return AXText.shortHash(title)
        }
        guard let first = blocks(in: root).first?.text, !first.isEmpty else { return nil }
        return AXText.shortHash(AXText.normalize(first))
    }

    func composerElement(appRoot: AXNode) -> AXNode? {
        // A hint match is required -- no role-only escape. This element gets WRITTEN to for native
        // continuation; a bare AXTextArea in a real window is just as likely to be the editor, the
        // find bar, or the terminal, and writing a checkpoint into a source file is the exact
        // data-loss shape the draft guard exists to prevent. Nil (-> clipboard fallback) is the
        // safe answer until the dump pass shows which hints these apps actually expose.
        appRoot.flattened().first { node in
            config.composerRoles.contains(node.axRole)
                && config.composerHints.contains { node.axHints.contains($0) }
        }
    }

    // MARK: heuristic block extraction

    /// A candidate turn: `axText` present and non-trivial, a plausible block role, and NOT already
    /// inside a chosen ancestor (take the outermost coherent block). `hints` is the block's own
    /// identity attributes PLUS every ancestor's -- these apps hang the role hint on a wrapper
    /// while the text lives on a nested leaf.
    private func blocks(in root: AXNode) -> [(node: AXNode, text: String, hints: String)] {
        var out: [(node: AXNode, text: String, hints: String)] = []
        var cutoff = -1

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
            guard config.blockRoles.contains(node.axRole), let text = node.axText else { continue }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            let substantial = trimmed.count >= 12 || trimmed.contains(" ")
            let hinted = hintRoleOrNil(hints) != nil
            guard !trimmed.isEmpty, substantial || hinted else { continue }
            out.append((node, trimmed, hints))
            cutoff = depth
        }
        return out
    }

    private func hintRoleOrNil(_ hints: String) -> String? {
        if config.userHints.contains(where: hints.contains) { return "user" }
        if config.assistantHints.contains(where: hints.contains) { return "assistant" }
        return nil
    }
}

// MARK: - registry

/// The set of native AI apps Thread can read. Adding one is a line here plus a config above.
enum AXAdapters {
    static let cursor = HeuristicAXAdapter(config: .cursor)
    static let claude = HeuristicAXAdapter(config: .claude)
    static let chatgpt = HeuristicAXAdapter(config: .chatgpt)

    static let all: [any AXConversationAdapter] = [cursor, claude, chatgpt]

    static func forBundleID(_ id: String) -> (any AXConversationAdapter)? {
        all.first { $0.bundleIDs.contains(id) }
    }

    /// Route by `Source` raw value ("claude" | "chatgpt" | "cursor"). nil for a tool with no
    /// native app (e.g. Gemini) -- the caller then falls back to a web chat.
    static func forSource(_ source: String) -> (any AXConversationAdapter)? {
        all.first { $0.source == source }
    }
}
