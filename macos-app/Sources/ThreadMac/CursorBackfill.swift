import Foundation
import SQLite3

/// Reads Cursor's local chat store directly -- `~/Library/Application Support/Cursor/User/
/// globalStorage/state.vscdb`, table `cursorDiskKV`. This is a STRUCTURED source, not a scrape,
/// so it is high-fidelity evidence -- but it still feeds the pipeline the same way everything
/// else does (raw evidence -> canonical events -> thinking engine -> ideas); nothing here
/// creates an idea. All this file produces is `{ id, role, text, createdAt }` turns + a capture
/// stamp for `ingestConversation`.
///
/// The shape (verified against a live install 2026-09-07 -- this is why native Cursor READ works
/// through local data where it didn't through Accessibility):
///
///   composerData:<composerId>          one conversation. `name` (title), `createdAt` /
///                                      `lastUpdatedAt` (epoch ms), `isDraft`, `modelConfig`, and
///                                      `fullConversationHeadersOnly`: an ordered array of
///                                      { bubbleId, type, createdAt }.  type 1 = user, 2 = assistant.
///   bubbleId:<composerId>:<bubbleId>   one message. `text` is the full turn; empty for a
///                                      thinking block (`capabilityType` 30) or a tool call
///                                      (`toolFormerData`) -- those are agent machinery, dropped.
///
/// The db is read from a COPY (state.vscdb + -wal + -shm) so a read never contends with Cursor
/// and always sees WAL-committed rows.
enum CursorBackfill {
    static var stateDbPath: String {
        ProcessInfo.processInfo.environment["THREAD_CURSOR_STATE_DB_PATH"]
            ?? NSString(string: "~/Library/Application Support/Cursor/User/globalStorage/state.vscdb").expandingTildeInPath
    }

    static var available: Bool { FileManager.default.fileExists(atPath: stateDbPath) }

    struct Message: Equatable {
        let bubbleId: String
        let role: String       // "user" | "assistant"
        let text: String
        let createdAt: String  // ISO 8601, from the conversation header
    }

    struct Conversation: Equatable {
        let composerId: String
        let title: String?
        let lastUpdatedAt: Date?
        let model: String?
        let messages: [Message]
        var id: String { "cursor::\(composerId)" }
    }

    // MARK: - read

    /// Every non-draft conversation with at least one text turn, oldest-first (deterministic, so
    /// a resumed backfill lands in the same place). Empty if the db is missing/unreadable.
    static func readConversations() -> [Conversation] {
        guard available, let (dir, dbPath) = copyDatabase() else { return [] }
        defer { try? FileManager.default.removeItem(at: dir) }

        var db: OpaquePointer?
        // READWRITE so SQLite can checkpoint the copied -wal; the copy is disposable.
        guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK, let db else {
            sqlite3_close(db); return []
        }
        defer { sqlite3_close(db) }

        let composerRows = rows(db, "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
        guard !composerRows.isEmpty else { return [] }

        // composerId -> bubbleId -> json, read once.
        var bubbles: [String: [String: [String: Any]]] = [:]
        for (key, data) in rows(db, "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'") {
            let parts = key.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
            guard parts.count == 3,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { continue }
            bubbles[String(parts[1]), default: [:]][String(parts[2])] = json
        }

        var out: [Conversation] = []
        for (key, data) in composerRows {
            let composerId = String(key.dropFirst("composerData:".count))
            guard let cd = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let c = parseConversation(composerId: composerId, composerData: cd,
                                            bubble: { bubbles[composerId]?[$0] })
            else { continue }
            out.append(c)
        }
        return out.sorted {
            ($0.lastUpdatedAt ?? .distantPast, $0.composerId) < ($1.lastUpdatedAt ?? .distantPast, $1.composerId)
        }
    }

    private static func rows(_ db: OpaquePointer, _ sql: String) -> [(key: String, value: Data)] {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        var out: [(String, Data)] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let keyC = sqlite3_column_text(stmt, 0) else { continue }
            let key = String(cString: keyC)
            let value: Data
            if let textC = sqlite3_column_text(stmt, 1) {
                value = Data(String(cString: textC).utf8)
            } else if let blob = sqlite3_column_blob(stmt, 1) {
                value = Data(bytes: blob, count: Int(sqlite3_column_bytes(stmt, 1)))
            } else { continue }
            out.append((key, value))
        }
        return out
    }

    private static func copyDatabase() -> (dir: URL, dbPath: String)? {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("thread-cursor-\(UUID().uuidString)")
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            let dst = dir.appendingPathComponent("state.vscdb").path
            try fm.copyItem(atPath: stateDbPath, toPath: dst)
            for suffix in ["-wal", "-shm"] where fm.fileExists(atPath: stateDbPath + suffix) {
                try? fm.copyItem(atPath: stateDbPath + suffix, toPath: dst + suffix)
            }
            return (dir, dst)
        } catch {
            try? fm.removeItem(at: dir)
            return nil
        }
    }

    // MARK: - pure parsing (unit-tested)

    static func roleFor(type: Any?) -> String? {
        switch (type as? NSNumber)?.intValue ?? (type as? Int) {
        case 1: return "user"
        case 2: return "assistant"
        default: return nil
        }
    }

    /// The turn's text, or nil for a thinking block / tool call / empty bubble.
    static func messageText(from bubble: [String: Any]) -> String? {
        guard let t = (bubble["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !t.isEmpty
        else { return nil }
        return t
    }

    /// One composerData value + a bubble lookup -> a Conversation. nil for a draft, an empty
    /// conversation, or one whose bubbles are all agent machinery (no text turns).
    static func parseConversation(
        composerId: String,
        composerData cd: [String: Any],
        bubble: (String) -> [String: Any]?
    ) -> Conversation? {
        if cd["isDraft"] as? Bool == true { return nil }
        guard let headers = cd["fullConversationHeadersOnly"] as? [[String: Any]], !headers.isEmpty
        else { return nil }

        var messages: [Message] = []
        for h in headers {
            guard let bid = h["bubbleId"] as? String,
                  let role = roleFor(type: h["type"]),
                  let b = bubble(bid),
                  let text = messageText(from: b)
            else { continue }
            messages.append(Message(
                bubbleId: bid, role: role, text: text,
                createdAt: (h["createdAt"] as? String) ?? Self.iso.string(from: Date())
            ))
        }
        guard !messages.isEmpty else { return nil }

        return Conversation(
            composerId: composerId,
            title: (cd["name"] as? String).flatMap { $0.isEmpty ? nil : $0 },
            lastUpdatedAt: epochMs(cd["lastUpdatedAt"]) ?? epochMs(cd["createdAt"]),
            model: (cd["modelConfig"] as? [String: Any])?["modelName"] as? String,
            messages: messages
        )
    }

    private static let iso = ISO8601DateFormatter()

    private static func epochMs(_ v: Any?) -> Date? {
        guard let ms = (v as? NSNumber)?.doubleValue ?? (v as? Double), ms > 0 else { return nil }
        return Date(timeIntervalSince1970: ms / 1000)
    }
}
