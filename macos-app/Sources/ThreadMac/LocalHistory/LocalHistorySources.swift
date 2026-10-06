import Foundation
import SQLite3

/// Every AI tool whose conversations Thread reads from files on this Mac.
enum LocalHistorySources {
    static let all: [any LocalHistorySource] = [
        ClaudeCodeHistory(),
        CodexHistory(),
        GeminiCLIHistory(),
        CopilotChatHistory(),
        JanHistory(),
        OllamaHistory(),
        LMStudioHistory(),
    ]

    /// Read a file's lines as JSON objects, skipping any that don't parse (a line being written
    /// right now, or a format change in one record type).
    static func jsonLines(_ path: String) -> [[String: Any]] {
        guard let data = FileManager.default.contents(atPath: path),
              let text = String(data: data, encoding: .utf8) else { return [] }
        return text.split(separator: "\n", omittingEmptySubsequences: true).compactMap { line in
            guard let d = line.data(using: .utf8) else { return nil }
            return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
        }
    }

    static func json(_ path: String) -> Any? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    /// Text of a content field that is either a string or an array of typed blocks; only the
    /// blocks of `types` count (tool calls, tool output and hidden reasoning are not thinking
    /// the person typed or read as the answer).
    static func text(_ content: Any?, types: Set<String> = ["text", "input_text", "output_text"]) -> String {
        if let s = content as? String { return s }
        guard let blocks = content as? [[String: Any]] else { return "" }
        return blocks.compactMap { b -> String? in
            guard let t = b["type"] as? String, types.contains(t) else { return nil }
            return b["text"] as? String
        }.joined(separator: "\n")
    }

    static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func isoDate(_ any: Any?) -> String {
        if let s = any as? String, !s.isEmpty { return s }
        if let n = any as? Double { return iso.string(from: Date(timeIntervalSince1970: n > 1e12 ? n / 1000 : n)) }
        if let n = any as? Int { return iso.string(from: Date(timeIntervalSince1970: Double(n) > 1e12 ? Double(n) / 1000 : Double(n))) }
        return iso.string(from: Date())
    }
}

// MARK: - Claude Code

/// Claude Code CLI: one append-only JSONL per session under ~/.claude/projects/<project>/.
/// Records: `user` / `assistant` (message.content is a string or typed blocks), plus summaries
/// and metadata. Kept: what the person typed and the assistant's prose. Dropped: tool calls,
/// tool results, hidden thinking, sub-agent (sidechain) traffic, meta/command records.
struct ClaudeCodeHistory: LocalHistorySource {
    let source = "claude_code"
    let displayName = "Claude Code"
    var roots: [String] { [home + "/.claude/projects"] }

    func isConversationFile(_ path: String) -> Bool {
        // Main sessions only: sub-agent and workflow transcripts live in <session>/subagents/.
        path.hasPrefix(home + "/.claude/projects/") && path.hasSuffix(".jsonl") && !path.contains("/subagents/")
    }

    func read(_ path: String) -> [LocalConversation] {
        let id = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
        return Self.parse(LocalHistorySources.jsonLines(path), fallbackId: id).map { [$0] } ?? []
    }

    static func parse(_ records: [[String: Any]], fallbackId: String) -> LocalConversation? {
        var sessionId: String?
        var out: [LocalMessage] = []
        var lastAssistantMessageId: String?

        for r in records {
            guard let type = r["type"] as? String, type == "user" || type == "assistant" else { continue }
            if (r["isSidechain"] as? Bool) == true || (r["isMeta"] as? Bool) == true { continue }
            guard let msg = r["message"] as? [String: Any] else { continue }
            sessionId = sessionId ?? (r["sessionId"] as? String)
            let uuid = (r["uuid"] as? String) ?? UUID().uuidString
            let at = LocalHistorySources.isoDate(r["timestamp"])

            if type == "user" {
                if r["toolUseResult"] != nil { continue }
                let text = LocalHistorySources.text(msg["content"], types: ["text"]).trimmingCharacters(in: .whitespacesAndNewlines)
                // Tool results come back as `user` records with only tool_result blocks -> empty.
                guard !text.isEmpty, !isCommandNoise(text) else { continue }
                out.append(LocalMessage(id: uuid, role: "user", text: text, createdAt: at))
                lastAssistantMessageId = nil
            } else {
                let text = LocalHistorySources.text(msg["content"], types: ["text"]).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { continue }
                // One reply can be split over several records sharing message.id -- join them.
                let mid = msg["id"] as? String
                if let mid, mid == lastAssistantMessageId, let prev = out.last, prev.role == "assistant" {
                    out[out.count - 1] = LocalMessage(id: prev.id, role: "assistant", text: prev.text + "\n\n" + text, createdAt: prev.createdAt)
                } else {
                    out.append(LocalMessage(id: uuid, role: "assistant", text: text, createdAt: at))
                }
                lastAssistantMessageId = mid
            }
        }
        guard out.contains(where: { $0.role == "user" }) else { return nil }
        return LocalConversation(id: sessionId ?? fallbackId, messages: out)
    }

    /// Slash commands, their local output and caveat banners are recorded as user text but are
    /// not the person's thinking.
    static func isCommandNoise(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespaces)
        return t.hasPrefix("<command-name>") || t.hasPrefix("<command-message>")
            || t.hasPrefix("<local-command-stdout>") || t.hasPrefix("<local-command-stderr>")
            || t.hasPrefix("<bash-input>") || t.hasPrefix("<bash-stdout>") || t.hasPrefix("<bash-stderr>")
            || t.hasPrefix("This session is being continued from a previous conversation")
            || t.hasPrefix("Caveat: The messages below were generated by the user while running local commands")
            || t.hasPrefix("[Request interrupted by user")
    }
}

// MARK: - OpenAI Codex CLI (and the ChatGPT app's Codex mode)

/// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, append-only. Every line is
/// `{timestamp, type, payload}`. The clean conversation signal is `event_msg` with
/// `user_message` / `agent_message` (response_item `role:user` also carries injected AGENTS.md
/// and environment context, so it isn't used). Sub-agent threads (`parent_thread_id`) are
/// skipped. Rollouts are zstd-compressed after 7 days -- by then they're history, not live.
struct CodexHistory: LocalHistorySource {
    let source = "codex"
    let displayName = "Codex"
    var roots: [String] { [home + "/.codex/sessions"] }

    func isConversationFile(_ path: String) -> Bool {
        path.hasPrefix(home + "/.codex/sessions/") && path.hasSuffix(".jsonl")
            && (path as NSString).lastPathComponent.hasPrefix("rollout-")
    }

    func read(_ path: String) -> [LocalConversation] {
        Self.parse(LocalHistorySources.jsonLines(path)).map { [$0] } ?? []
    }

    static func parse(_ records: [[String: Any]]) -> LocalConversation? {
        var id: String?
        var out: [LocalMessage] = []
        for (n, r) in records.enumerated() {
            guard let type = r["type"] as? String, let p = r["payload"] as? [String: Any] else { continue }
            let at = LocalHistorySources.isoDate(r["timestamp"])
            if type == "session_meta" {
                if p["parent_thread_id"] is String { return nil }   // a sub-agent thread
                id = (p["id"] as? String) ?? (p["session_id"] as? String)
                continue
            }
            guard type == "event_msg", let kind = p["type"] as? String,
                  let text = (p["message"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty
            else { continue }
            if kind == "user_message" {
                out.append(LocalMessage(id: "u\(n)", role: "user", text: text, createdAt: at))
            } else if kind == "agent_message" {
                out.append(LocalMessage(id: "a\(n)", role: "assistant", text: text, createdAt: at))
            }
        }
        guard let id, out.contains(where: { $0.role == "user" }) else { return nil }
        return LocalConversation(id: id, messages: out)
    }
}

// MARK: - Google Gemini CLI

/// ~/.gemini/tmp/<project>/chats/session-*.jsonl. Line 1 is metadata (sessionId); then message
/// records `{id, timestamp, type: user|gemini|info|error|warning, content, displayContent?}` --
/// appended with upsert semantics (a later line with the same id replaces it), plus control
/// lines: `$set` (may replace `messages` wholesale), `$rewindTo` (drop that message and after),
/// `$patch`. Sub-agent sessions sit in chats/<parent>/ and are skipped.
struct GeminiCLIHistory: LocalHistorySource {
    let source = "gemini_cli"
    let displayName = "Gemini CLI"
    var roots: [String] { [home + "/.gemini/tmp", home + "/.cache/.gemini/tmp"] }

    func isConversationFile(_ path: String) -> Bool {
        let name = (path as NSString).lastPathComponent
        let parent = ((path as NSString).deletingLastPathComponent as NSString).lastPathComponent
        return roots.contains { path.hasPrefix($0 + "/") } && parent == "chats"
            && name.hasPrefix("session-") && name.hasSuffix(".jsonl")
    }

    func read(_ path: String) -> [LocalConversation] {
        Self.parse(LocalHistorySources.jsonLines(path)).map { [$0] } ?? []
    }

    static func parse(_ records: [[String: Any]]) -> LocalConversation? {
        var sessionId: String?
        var order: [String] = []
        var byId: [String: [String: Any]] = [:]

        func upsert(_ m: [String: Any]) {
            guard let id = m["id"] as? String else { return }
            if byId[id] == nil { order.append(id) }
            byId[id] = m
        }

        for r in records {
            if let set = r["$set"] as? [String: Any] {
                if let sid = set["sessionId"] as? String { sessionId = sid }
                if let msgs = set["messages"] as? [[String: Any]] {
                    order = []; byId = [:]
                    msgs.forEach(upsert)
                }
                continue
            }
            if let to = r["$rewindTo"] as? String {
                if let i = order.firstIndex(of: to) {
                    for id in order[i...] { byId[id] = nil }
                    order.removeSubrange(i...)
                }
                continue
            }
            if r["$patch"] != nil { continue }
            if r["type"] == nil, let sid = r["sessionId"] as? String { sessionId = sid; continue }
            upsert(r)
        }

        let out: [LocalMessage] = order.compactMap { id in
            guard let m = byId[id], let type = m["type"] as? String else { return nil }
            let role: String
            switch type {
            case "user": role = "user"
            case "gemini": role = "assistant"
            default: return nil   // info / error / warning
            }
            // displayContent is what the person saw/typed; content may hold expanded @file text.
            let raw = text(m["displayContent"]).isEmpty ? text(m["content"]) : text(m["displayContent"])
            let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty else { return nil }
            return LocalMessage(id: id, role: role, text: t, createdAt: LocalHistorySources.isoDate(m["timestamp"]))
        }
        guard let sessionId, out.contains(where: { $0.role == "user" }) else { return nil }
        return LocalConversation(id: sessionId, messages: out)
    }

    /// PartListUnion: a string, a `{text}` part, or an array of either.
    static func text(_ any: Any?) -> String {
        if let s = any as? String { return s }
        if let p = any as? [String: Any] { return (p["text"] as? String) ?? "" }
        if let a = any as? [Any] { return a.map { text($0) }.filter { !$0.isEmpty }.joined(separator: "\n") }
        return ""
    }
}

// MARK: - VS Code GitHub Copilot Chat

/// <Code>/User/workspaceStorage/<ws>/chatSessions/<session>.jsonl (+ globalStorage's
/// emptyWindowChatSessions). Since 2026 each file is a MUTATION LOG -- lines
/// `{kind, k?, v?, i?}`: 0 = initial object, 1 = set at path k, 2 = push v onto the array at k
/// (truncating to i first), 3 = delete at k -- replayed to rebuild the session. Legacy `.json`
/// files hold the object directly. Each request: `message.text` (the person) and `response[]`,
/// whose markdown parts are bare `{value}` (no `kind`); tool calls, thinking and edits carry a
/// `kind` and are skipped.
struct CopilotChatHistory: LocalHistorySource {
    let source = "copilot"
    let displayName = "GitHub Copilot (VS Code)"
    private var userDirs: [String] {
        ["Code", "Code - Insiders"].map { home + "/Library/Application Support/\($0)/User" }
    }
    var roots: [String] { userDirs.flatMap { [$0 + "/workspaceStorage", $0 + "/globalStorage/emptyWindowChatSessions"] } }

    func isConversationFile(_ path: String) -> Bool {
        let dir = ((path as NSString).deletingLastPathComponent as NSString).lastPathComponent
        return userDirs.contains { path.hasPrefix($0 + "/") }
            && (dir == "chatSessions" || dir == "emptyWindowChatSessions")
            && (path.hasSuffix(".jsonl") || path.hasSuffix(".json"))
    }

    func read(_ path: String) -> [LocalConversation] {
        let session: [String: Any]?
        if path.hasSuffix(".jsonl") {
            session = Self.replay(LocalHistorySources.jsonLines(path))
        } else {
            session = LocalHistorySources.json(path) as? [String: Any]
        }
        guard let session else { return [] }
        return Self.conversation(session).map { [$0] } ?? []
    }

    static func replay(_ lines: [[String: Any]]) -> [String: Any]? {
        var root: Any? = nil
        for l in lines {
            guard let kind = l["kind"] as? Int else { continue }
            let path = (l["k"] as? [Any]) ?? []
            switch kind {
            case 0: root = l["v"]
            case 1: root = MutationLog.set(root, path, l["v"])
            case 2: root = MutationLog.push(root, path, (l["v"] as? [Any]) ?? [], truncateTo: l["i"] as? Int)
            case 3: root = MutationLog.set(root, path, nil)
            default: continue
            }
        }
        return root as? [String: Any]
    }

    static func conversation(_ s: [String: Any]) -> LocalConversation? {
        guard let sid = s["sessionId"] as? String, let requests = s["requests"] as? [[String: Any]] else { return nil }
        var out: [LocalMessage] = []
        for r in requests {
            if (r["isSystemInitiated"] as? Bool) == true || (r["hiddenFromTranscript"] as? Bool) == true { continue }
            let rid = (r["requestId"] as? String) ?? UUID().uuidString
            let asked = ((r["message"] as? [String: Any])?["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !asked.isEmpty else { continue }
            out.append(LocalMessage(id: rid, role: "user", text: asked, createdAt: LocalHistorySources.isoDate(r["timestamp"])))
            let parts = (r["response"] as? [[String: Any]]) ?? []
            let answer = parts.filter { $0["kind"] == nil }.compactMap { $0["value"] as? String }
                .joined().trimmingCharacters(in: .whitespacesAndNewlines)
            if !answer.isEmpty {
                let at = r["responseTimestamp"] ?? r["timestamp"]
                out.append(LocalMessage(id: (r["responseId"] as? String) ?? rid + "_r", role: "assistant", text: answer, createdAt: LocalHistorySources.isoDate(at)))
            }
        }
        guard !out.isEmpty else { return nil }
        return LocalConversation(id: sid, messages: out)
    }
}

/// Path-addressed set/push over JSON values (dictionaries by string key, arrays by index).
enum MutationLog {
    static func set(_ node: Any?, _ path: [Any], _ value: Any?) -> Any? {
        guard let head = path.first else { return value }
        let rest = Array(path.dropFirst())
        if let key = head as? String {
            var d = (node as? [String: Any]) ?? [:]
            d[key] = set(d[key], rest, value)
            return d
        }
        if let idx = head as? Int, var a = node as? [Any] {
            if idx < a.count {
                if rest.isEmpty && value == nil { a.remove(at: idx) } else { a[idx] = set(a[idx], rest, value) ?? NSNull() }
            } else if idx == a.count, let v = set(nil, rest, value) {
                a.append(v)
            }
            return a
        }
        return node
    }

    static func push(_ node: Any?, _ path: [Any], _ items: [Any], truncateTo: Int?) -> Any? {
        let current = get(node, path) as? [Any] ?? []
        var next = truncateTo.map { Array(current.prefix($0)) } ?? current
        next.append(contentsOf: items)
        return set(node, path, next)
    }

    static func get(_ node: Any?, _ path: [Any]) -> Any? {
        var cur = node
        for p in path {
            if let k = p as? String { cur = (cur as? [String: Any])?[k] }
            else if let i = p as? Int, let a = cur as? [Any], i < a.count { cur = a[i] }
            else { return nil }
        }
        return cur
    }
}

// MARK: - Jan

/// ~/Library/Application Support/Jan/data/threads/<thread>/messages.jsonl -- one message per
/// line: `{id, role, content:[{type:"text", text:{value}}], created_at}`; appended as you chat.
struct JanHistory: LocalHistorySource {
    let source = "jan"
    let displayName = "Jan"
    var roots: [String] { [home + "/Library/Application Support/Jan/data/threads", home + "/jan/threads"] }

    func isConversationFile(_ path: String) -> Bool {
        roots.contains { path.hasPrefix($0 + "/") } && (path as NSString).lastPathComponent == "messages.jsonl"
    }

    func read(_ path: String) -> [LocalConversation] {
        let thread = ((path as NSString).deletingLastPathComponent as NSString).lastPathComponent
        return Self.parse(LocalHistorySources.jsonLines(path), threadId: thread).map { [$0] } ?? []
    }

    static func parse(_ records: [[String: Any]], threadId: String) -> LocalConversation? {
        let out: [LocalMessage] = records.compactMap { r in
            guard let role = r["role"] as? String, role == "user" || role == "assistant" else { return nil }
            let blocks = (r["content"] as? [[String: Any]]) ?? []
            let text = blocks.compactMap { b -> String? in
                guard (b["type"] as? String) == "text" else { return nil }
                return ((b["text"] as? [String: Any])?["value"] as? String) ?? (b["text"] as? String)
            }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return LocalMessage(id: (r["id"] as? String) ?? UUID().uuidString, role: role, text: text,
                                createdAt: LocalHistorySources.isoDate(r["created_at"]))
        }
        guard out.contains(where: { $0.role == "user" }) else { return nil }
        return LocalConversation(id: threadId, messages: out)
    }
}

// MARK: - Ollama (desktop app)

/// The Ollama app keeps chats in SQLite: ~/Library/Application Support/Ollama/db.sqlite with
/// `chats(id, title, created_at)` and `messages(id, chat_id, role, content, created_at)`.
/// One file, many conversations. Opened read-only.
struct OllamaHistory: LocalHistorySource {
    let source = "ollama"
    let displayName = "Ollama"
    private var dir: String { home + "/Library/Application Support/Ollama" }
    var roots: [String] { [dir] }

    func isConversationFile(_ path: String) -> Bool {
        // The WAL is where writes land first; a change to either means "re-read the db".
        path == dir + "/db.sqlite" || path == dir + "/db.sqlite-wal"
    }

    func read(_ path: String) -> [LocalConversation] {
        var db: OpaquePointer?
        guard sqlite3_open_v2(dir + "/db.sqlite", &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db else { return [] }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, 1000)
        let sql = "SELECT chat_id, id, role, content, created_at FROM messages WHERE role IN ('user','assistant') ORDER BY chat_id, created_at, id"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        var byChat: [(String, [LocalMessage])] = []
        func col(_ i: Int32) -> String { sqlite3_column_text(stmt, i).map { String(cString: $0) } ?? "" }
        while sqlite3_step(stmt) == SQLITE_ROW {
            let chat = col(0)
            let text = col(3).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !chat.isEmpty, !text.isEmpty else { continue }
            let m = LocalMessage(id: "\(chat)_\(col(1))", role: col(2), text: text, createdAt: LocalHistorySources.isoDate(col(4)))
            if byChat.last?.0 == chat { byChat[byChat.count - 1].1.append(m) } else { byChat.append((chat, [m])) }
        }
        return byChat.filter { $0.1.contains { $0.role == "user" } }.map { LocalConversation(id: $0.0, messages: $0.1) }
    }
}

// MARK: - LM Studio (best effort)

/// ~/.lmstudio/conversations/<id>.conversation.json, rewritten per change. LM Studio calls this
/// format internal, so this reader is deliberately tolerant: each message has `versions[]` (one
/// per regeneration) and we take the selected one; user text is `content[].text`, the reply is
/// the `steps[]` content blocks, skipping thinking and tool steps.
struct LMStudioHistory: LocalHistorySource {
    let source = "lm_studio"
    let displayName = "LM Studio"
    var roots: [String] { [home + "/.lmstudio/conversations"] }

    func isConversationFile(_ path: String) -> Bool {
        path.hasPrefix(home + "/.lmstudio/conversations/") && path.hasSuffix(".conversation.json")
    }

    func read(_ path: String) -> [LocalConversation] {
        guard let obj = LocalHistorySources.json(path) as? [String: Any] else { return [] }
        let name = (path as NSString).lastPathComponent.replacingOccurrences(of: ".conversation.json", with: "")
        let mtime = (try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date) ?? Date()
        return Self.parse(obj, id: name, fallbackDate: LocalHistorySources.iso.string(from: mtime)).map { [$0] } ?? []
    }

    static func parse(_ obj: [String: Any], id: String, fallbackDate: String) -> LocalConversation? {
        let messages = (obj["messages"] as? [[String: Any]]) ?? []
        var out: [LocalMessage] = []
        for (n, m) in messages.enumerated() {
            let versions = (m["versions"] as? [[String: Any]]) ?? [m]
            let pick = (m["currentlySelected"] as? Int).flatMap { versions.indices.contains($0) ? versions[$0] : nil } ?? versions.last
            guard let v = pick, let role = v["role"] as? String, role == "user" || role == "assistant" else { continue }
            var text = LocalHistorySources.text(v["content"], types: ["text"])
            if role == "assistant", text.isEmpty {
                let steps = (v["steps"] as? [[String: Any]]) ?? []
                text = steps.filter { ($0["type"] as? String) == "contentBlock" && (($0["style"] as? [String: Any])?["type"] as? String) != "thinking" }
                    .map { LocalHistorySources.text($0["content"], types: ["text"]) }
                    .joined(separator: "\n")
            }
            let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty else { continue }
            out.append(LocalMessage(id: "\(id)_\(n)", role: role, text: t, createdAt: fallbackDate))
        }
        guard out.contains(where: { $0.role == "user" }) else { return nil }
        return LocalConversation(id: id, messages: out)
    }
}
