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

    /// True when this adapter's extraction has not yet been checked against a real AX dump of a
    /// full conversation. The sensor still RUNS it (so `THREAD_AX_DUMP=1` can measure it), but
    /// won't write its output to the graph. Flip to false once a dump confirms both roles.
    var extractionUnverified: Bool { get }
}

extension AXConversationAdapter {
    func composerElement(appRoot: AXNode) -> AXNode? { nil }
    var extractionUnverified: Bool { false }
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

    /// When non-empty, the adapter switches from "find a hinted container + alternate" to
    /// heading-anchored extraction: a leaf whose text matches one of these (case-insensitive,
    /// exact or prefix) opens a new USER turn, and everything substantial until the next such
    /// leaf is that turn's assistant reply. This is the shape ChatGPT's desktop tree actually
    /// has -- every container is a hint-less `AXGroup`, but each user turn is preceded by an
    /// `AXHeading` reading "You said:". Verified against a real AX dump 2026-09-07.
    var userTurnHeadings: [String] = []

    /// The assistant-side counterpart -- an `AXHeading` reading "ChatGPT said:". Only consulted
    /// when `userTurnHeadings` is set. Verified against a real AX dump 2026-09-07.
    var assistantTurnHeadings: [String] = []

    /// See `AXConversationAdapter.extractionUnverified`. It is PERMANENTLY set for all three
    /// adapters -- native AX READ was measured against real dumps of every one on 2026-09-07 and
    /// failed, each its own way:
    ///   - ChatGPT: re-renders an assistant turn as it streams and drifts UI chrome (status line,
    ///     attachment banner) through the same subtree -> the text differs on every scan, so
    ///     content-derived message ids never dedupe. No conversation id in the tree.
    ///   - Claude Desktop: `AXApplication` returns ZERO children even after the Chromium
    ///     `AXManualAccessibility` opt-in -- it doesn't expose its content to Accessibility at all.
    ///   - Cursor: the tree populates, but it's the agent panel -- "Thought 2s", "Explored N
    ///     searches", "Fork chat", tool-call/approval rows and status lines interleaved with
    ///     messages; roles are unrecoverable, the block count swings 1..26 across consecutive
    ///     scans of one conversation, timestamps mutate, and there's no stable conversation id.
    /// So the AX READ sensor is a measurement rig, never a shipped capture path. READ is served
    /// by the browser extension (real selectors, URL conversation id). THREAD.md §17's
    /// native > accessibility > browser ladder is a preference, and AX lost these apps on the
    /// merits. Native WRITE (continuation) is a SEPARATE story and works -- the ChatGPT and
    /// Cursor composers are both `[value-settable]`.
    var extractionUnverified: Bool = true

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
        // The desktop app ships under `com.openai.chat` on some installs and `com.openai.codex`
        // on others (OpenAI folded the two apps together) -- claim both. Verified `com.openai.codex`
        // on a real machine 2026-09-07.
        bundleIDs: ["com.openai.chat", "com.openai.codex"],
        source: "chatgpt",
        userHints: ["user", "you said", "your message"],
        assistantHints: ["assistant", "chatgpt", "chatgpt said", "gpt", "ai response", "response"],
        chatContainerHints: ["chat", "conversation", "messages", "thread"],
        userTurnHeadings: ["you said:", "you said"],
        assistantTurnHeadings: ["chatgpt said:", "assistant said:", "chatgpt responded"]
        // extractionUnverified defaults true -- see the field doc for why READ failed on all three.
    )
}

/// Reads a native AI app's chat pane through Accessibility, driven by `AXAdapterConfig`.
///
/// Measured against real dumps of all three apps 2026-09-07 and found unusable for READ (see
/// `AXAdapterConfig.extractionUnverified`) -- these are Electron / web-view apps whose bridged
/// DOM trees shred prose into per-span leaves, interleave agent chrome, and carry no stable
/// conversation id. So `extractionUnverified` is set for every adapter and this code is a
/// measurement rig, never a shipped read path. It still matches on broad hints + alternation and
/// degrades to "found nothing" rather than a confident wrong answer. Cursor READ is served by
/// the structured local store (`CursorBackfill`); the AX layer's real job is WRITE
/// (`NativeContinuation` / `composerElement`).
struct HeuristicAXAdapter: AXConversationAdapter {
    let config: AXAdapterConfig

    var bundleIDs: [String] { config.bundleIDs }
    var source: String { config.source }
    var extractionUnverified: Bool { config.extractionUnverified }

    func conversationRoot(appRoot: AXNode) -> AXNode? {
        if !config.userTurnHeadings.isEmpty {
            // Heading-anchored apps (ChatGPT): nothing in the tree carries a container hint, so
            // the scope is the whole web area and `headingAnchoredBlocks` does the filtering.
            // nil only when there's no web content at all (a loading window).
            return appRoot.flattened(maxDepth: 60).first { $0.axRole == "AXWebArea" } ?? appRoot
        }

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
        if !config.userTurnHeadings.isEmpty { return headingAnchoredBlocks(root) }
        return blocks(in: root).enumerated().map { index, block in
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
        if !config.userTurnHeadings.isEmpty {
            // No conversation id anywhere in ChatGPT's tree. Hash the first turn -- prefer the
            // first USER turn (most stable), else the first turn of any role (a transient scan
            // mid-stream may briefly have only an assistant turn). TODO: a stable handle for a
            // long conversation whose first turn has scrolled out is still unsolved.
            let blocks = headingAnchoredBlocks(root)
            let anchor = blocks.first(where: { $0.role == "user" })?.text ?? blocks.first?.text
            guard let anchor, !anchor.isEmpty else { return nil }
            return AXText.shortHash(AXText.normalize(anchor))
        }
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

    // MARK: heading-anchored extraction (ChatGPT-shaped trees)

    /// Walk leaves in order. A leaf matching `userTurnHeadings` / `assistantTurnHeadings` opens a
    /// turn of that role; every substantial leaf after it (until the next heading, or that turn's
    /// action buttons) is the message. ChatGPT shatters one sentence across a leaf per styled
    /// span, so runs are joined on a space and the space-before-punctuation that produces is
    /// tightened back up. Sidebar / project text before the first heading is skipped (`role` is
    /// nil); UI chrome is denylisted; the composer `AXTextArea` ends the transcript; a turn
    /// that's still streaming ("ChatGPT is responding") is dropped rather than captured unstably.
    /// Roles are `.explicit`. VERIFIED SHAPE ONLY -- `extractionUnverified` keeps this
    /// measurement-only until streaming/settle and long-conversation behaviour are confirmed.
    private func headingAnchoredBlocks(_ root: AXNode) -> [AXMessageBlock] {
        var out: [AXMessageBlock] = []
        var role: String?
        var parts: [String] = []
        var turnClosed = false     // seen this turn's action buttons -> ignore trailing chrome
        var streamingTail = false  // "ChatGPT is responding" seen -> last turn isn't settled

        func flush() {
            defer { parts.removeAll(); turnClosed = false }
            guard let r = role, !parts.isEmpty else { return }
            var text = parts.joined(separator: " ")
            text = text.replacingOccurrences(of: #" +([,.;:!?%)\]”’])"#, with: "$1", options: .regularExpression)
            text = text.replacingOccurrences(of: #"([(\[“‘]) +"#, with: "$1", options: .regularExpression)
            text = text.replacingOccurrences(of: #"\s{2,}"#, with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if text.count >= 2 { out.append(AXMessageBlock(role: r, text: text, roleConfidence: .explicit)) }
        }

        for node in root.flattened(maxDepth: 70) {
            let r = node.axRole
            if r == "AXTextArea" || r == "AXTextField" { break }  // the composer
            guard r == "AXHeading" || r == "AXStaticText" else { continue }
            guard let raw = node.axText?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty
            else { continue }
            let low = raw.lowercased()

            if config.userTurnHeadings.contains(where: { low == $0 || low.hasPrefix($0) }) {
                flush(); role = "user"; continue
            }
            if config.assistantTurnHeadings.contains(where: { low == $0 || low.hasPrefix($0) }) {
                flush(); role = "assistant"; continue
            }
            if low == "chatgpt is responding" { streamingTail = true; continue }
            if Self.chromeCloses.contains(low) { turnClosed = true; continue }
            if Self.chromeSkip.contains(low) || isLikelyTimestamp(raw)
                || Self.chromePrefixes.contains(where: low.hasPrefix) { continue }

            if role != nil, !turnClosed { parts.append(raw) }
        }

        // A still-streaming trailing turn changes text every scan -- every version hashes to a
        // different message id. Drop it; the settle re-scan captures it once it's done.
        if streamingTail, role == "assistant" { parts.removeAll(); role = nil }
        flush()
        return out
    }

    /// Buttons that mark the END of a turn's content -- anything after them (until the next
    /// heading) is chrome, not message text.
    private static let chromeCloses: Set<String> = [
        "copy", "copy message", "regenerate response", "rate response", "more actions",
    ]
    /// Leaves that are never message content, wherever they appear.
    private static let chromeSkip: Set<String> = [
        "you said:", "chatgpt said:", "edit message", "share", "send", "dictate",
        "add files and more", "message chatgpt", "select chatgpt model",
        "you've reached the limit for file attachments",
    ]
    // Only unambiguous chrome -- a plan/upgrade phrase can be real message content.
    private static let chromePrefixes: [String] = ["attachments are unavailable until"]

    private func isLikelyTimestamp(_ s: String) -> Bool {
        s.range(of: #"^\d{1,2}:\d{2}(:\d{2})?\s?(AM|PM)?$"#,
                options: [.regularExpression, .caseInsensitive]) != nil
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
