import Foundation
import SQLite3

/// Cursor keeps its chat/composer history in a local SQLite `state.vscdb` (a VS Code storage
/// convention), so unlike ChatGPT/Claude its backfill needs no export -- this reads it directly.
///
/// UNVERIFIED against a real Cursor install, exactly like the desktop-agent's TS version it
/// mirrors: the `ItemTable(key,value)` mechanism is stable VS Code behaviour, but the exact keys
/// Cursor uses and the JSON shape inside them are undocumented. So this scans every plausibly
/// chat-related value and recursively looks for arrays that *structurally* look like message
/// lists -- degrading to "found nothing", never a crash or silent garbage, if the shape differs.
enum CursorBackfill {
    static var stateDbPath: String {
        ProcessInfo.processInfo.environment["THREAD_CURSOR_STATE_DB_PATH"]
            ?? NSString(string: "~/Library/Application Support/Cursor/User/globalStorage/state.vscdb").expandingTildeInPath
    }

    static var available: Bool { FileManager.default.fileExists(atPath: stateDbPath) }

    struct Conversation {
        let id: String
        let messages: [(role: String, text: String)]
    }

    private static let userRoles: Set<String> = ["user", "human"]
    private static let assistantRoles: Set<String> = ["assistant", "ai", "model", "bot"]

    /// Read + heuristically extract every conversation from `state.vscdb`. Empty if the file is
    /// missing or nothing message-shaped is found.
    static func readConversations() -> [Conversation] {
        guard available else { return [] }
        var db: OpaquePointer?
        guard sqlite3_open_v2(stateDbPath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db else {
            sqlite3_close(db); return []
        }
        defer { sqlite3_close(db) }

        var stmt: OpaquePointer?
        let sql = "SELECT key, value FROM ItemTable WHERE key LIKE '%chat%' OR key LIKE '%composer%' OR key LIKE '%aichat%'"
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }

        var out: [Conversation] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let keyC = sqlite3_column_text(stmt, 0) else { continue }
            let key = String(cString: keyC)

            let value: Data
            if let textC = sqlite3_column_text(stmt, 1) {
                value = Data(String(cString: textC).utf8)
            } else if let blob = sqlite3_column_blob(stmt, 1) {
                value = Data(bytes: blob, count: Int(sqlite3_column_bytes(stmt, 1)))
            } else { continue }

            guard let json = try? JSONSerialization.jsonObject(with: value) else { continue }
            let found = scanForMessages(json)
            if found.isEmpty { continue }
            out.append(Conversation(id: "cursor::\(key)", messages: found))
        }
        return out
    }

    // MARK: - the heuristic scan (mirror of desktop-agent/src/sources/cursor.ts)

    private static func asMessage(_ item: Any) -> (role: String, text: String)? {
        guard let obj = item as? [String: Any] else { return nil }
        let roleRaw = (obj["role"] ?? obj["type"] ?? obj["author"] ?? obj["sender"]) as? String
        guard let roleLower = roleRaw?.lowercased() else { return nil }
        let role: String
        if userRoles.contains(roleLower) { role = "user" }
        else if assistantRoles.contains(roleLower) { role = "assistant" }
        else { return nil }

        let text = (obj["text"] ?? obj["content"] ?? obj["message"]) as? String
        guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return (role, trimmed)
    }

    static func scanForMessages(_ value: Any, depth: Int = 0) -> [(role: String, text: String)] {
        guard depth <= 6 else { return [] }
        if let array = value as? [Any] {
            let msgs = array.compactMap(asMessage)
            // Most entries must look like messages -- an incidental array shouldn't pass.
            if !array.isEmpty, Double(msgs.count) >= Double(array.count) * 0.6 { return msgs }
            return array.flatMap { scanForMessages($0, depth: depth + 1) }
        }
        if let dict = value as? [String: Any] {
            return dict.values.flatMap { scanForMessages($0, depth: depth + 1) }
        }
        return []
    }
}
