import Foundation

/// Every AI tool whose conversations Thread reads from files on this Mac.
enum LocalHistorySources {
    static let all: [any LocalHistorySource] = [
        ClaudeCodeHistory(),
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
        path.hasPrefix(home + "/.claude/projects/") && path.hasSuffix(".jsonl")
    }

    func read(_ path: String) -> LocalConversation? {
        Self.parse(LocalHistorySources.jsonLines(path), fallbackId: (path as NSString).deletingPathExtension.components(separatedBy: "/").last ?? path)
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
            || t.hasPrefix("Caveat: The messages below were generated by the user while running local commands")
            || t.hasPrefix("[Request interrupted by user")
    }
}
