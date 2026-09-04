import Foundation

/// "Recover my thinking": turn an existing ChatGPT / Claude data export into ideas. The engine
/// only -- state + UI live in AppState / BackfillView.
///
/// ChatGPT and Claude keep no full local conversation history (unlike Cursor), so the archive
/// comes from the official data export the user requests from the provider: a `.zip` (or a bare
/// `conversations.json` if they've unpacked it) that lands in Downloads. This finds one already
/// there, watches for a fresh one, and feeds it to `POST /v1/import` in bounded batches.
enum BackfillKind: String, CaseIterable {
    case chatgpt, claude

    var apiFormat: String { rawValue }
    var displayName: String { self == .chatgpt ? "ChatGPT" : "Claude" }

    /// The provider page where the user starts a data export.
    var exportPageURL: URL {
        switch self {
        case .chatgpt: return URL(string: "https://chatgpt.com/#settings/DataControls")!
        case .claude: return URL(string: "https://claude.ai/settings/data-privacy-controls")!
        }
    }
}

struct DetectedExport: Identifiable, Equatable {
    let url: URL
    let kind: BackfillKind
    let conversationCount: Int
    let modified: Date
    var id: URL { url }
}

struct BackfillProgress: Equatable {
    var conversationsDone: Int
    var conversationsTotal: Int
    var ideaCount: Int
}

enum BackfillError: LocalizedError {
    case notReadable
    case notAnExport
    case emptyExport
    var errorDescription: String? {
        switch self {
        case .notReadable: return "That file couldn't be read."
        case .notAnExport: return "That doesn't look like a ChatGPT or Claude export."
        case .emptyExport: return "That export has no conversations in it."
        }
    }
}

enum Backfill {
    /// Conversations per `/v1/import` call. The server caps at 25; stay under it for request size.
    static let batchSize = 15

    private static var searchDirs: [URL] {
        let fm = FileManager.default
        return [
            fm.urls(for: .downloadsDirectory, in: .userDomainMask).first,
            fm.urls(for: .desktopDirectory, in: .userDomainMask).first,
        ].compactMap { $0 }
    }

    // MARK: - Finding an export already on disk

    /// Any ChatGPT/Claude export sitting in Downloads or on the Desktop, newest first. Cheap:
    /// only peeks at the first few KB of each candidate.
    static func scanForExistingExports() -> [DetectedExport] {
        let fm = FileManager.default
        let cutoff = Date().addingTimeInterval(-365 * 24 * 3600)
        var found: [DetectedExport] = []

        for dir in searchDirs {
            let items = (try? fm.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey], options: [.skipsHiddenFiles]
            )) ?? []
            for url in items {
                let ext = url.pathExtension.lowercased()
                guard ext == "zip" || ext == "json" else { continue }
                let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                guard modified > cutoff else { continue }
                if let export = inspect(url, modified: modified) { found.append(export) }
            }
        }
        return found.sorted { $0.modified > $1.modified }
    }

    /// Is `url` a ChatGPT/Claude export? Returns its kind + a rough conversation count, or nil.
    static func inspect(_ url: URL, modified: Date = Date()) -> DetectedExport? {
        let sample: String
        var fullArray: [Any]?

        if url.pathExtension.lowercased() == "zip" {
            guard zipContainsConversationsJson(url) else { return nil }
            sample = shell("/usr/bin/unzip", ["-p", url.path, "conversations.json"], maxBytes: 8192) ?? ""
        } else {
            guard let data = try? Data(contentsOf: url) else { return nil }
            sample = String(data: data.prefix(8192), encoding: .utf8) ?? ""
            fullArray = (try? JSONSerialization.jsonObject(with: data)) as? [Any]
        }

        guard sample.first(where: { !$0.isWhitespace }) == "[" else { return nil }
        let kind: BackfillKind
        if sample.contains("\"mapping\"") || sample.contains("\"current_node\"") {
            kind = .chatgpt
        } else if sample.contains("\"chat_messages\"") || sample.contains("\"sender\"") {
            kind = .claude
        } else {
            return nil
        }

        // Count: exact for a loaded .json, a "zip -l" grep estimate otherwise. Off-by-a-bit is
        // fine -- it's only shown as "~N conversations" and drives the progress denominator once
        // the real array is loaded in run().
        let count = fullArray?.count ?? roughZipConversationCount(url, kind: kind)
        return DetectedExport(url: url, kind: kind, conversationCount: max(count, 1), modified: modified)
    }

    // MARK: - Watching Downloads for a fresh export

    /// Calls `onFound` (on the main queue) when a new ChatGPT/Claude export appears in Downloads.
    /// Returns a handle; call `.cancel()` to stop.
    static func watchDownloads(onFound: @escaping (DetectedExport) -> Void) -> DispatchSourceFileSystemObject? {
        guard let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first else { return nil }
        let fd = open(dir.path, O_EVTONLY)
        guard fd >= 0 else { return nil }
        let src = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd, eventMask: [.write, .extend], queue: DispatchQueue.global(qos: .utility)
        )
        var known = Set(scanForExistingExports().map(\.url))
        var debounce: DispatchWorkItem?
        src.setEventHandler {
            debounce?.cancel()
            let work = DispatchWorkItem {
                for export in scanForExistingExports() where !known.contains(export.url) {
                    known.insert(export.url)
                    DispatchQueue.main.async { onFound(export) }
                }
            }
            debounce = work
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1.5, execute: work)
        }
        src.setCancelHandler { close(fd) }
        src.resume()
        return src
    }

    // MARK: - Running an import

    /// Feed `export` to the backend in batches. `progress` fires after each batch (main queue).
    /// Returns the final summary. Stops early and returns what it got on a 402 (Free cap hit).
    static func run(
        _ export: DetectedExport,
        client: APIClient,
        progress: @escaping (BackfillProgress) -> Void
    ) async throws -> (summary: ImportSummary, cappedAt: Int?) {
        let jsonURL = try materializeConversationsJson(export.url)
        defer { if jsonURL != export.url { try? FileManager.default.removeItem(at: jsonURL.deletingLastPathComponent()) } }

        guard let data = try? Data(contentsOf: jsonURL) else { throw BackfillError.notReadable }
        guard let all = (try? JSONSerialization.jsonObject(with: data)) as? [Any] else { throw BackfillError.notAnExport }
        guard !all.isEmpty else { throw BackfillError.emptyExport }

        var done = 0
        var latest = ImportSummary(newCanonicalEvents: 0, newCognitiveEvents: 0, rejectedExtractions: 0, ideaCount: 0)

        var index = 0
        while index < all.count {
            let batch = Array(all[index ..< min(index + batchSize, all.count)])
            do {
                let s = try await client.importBatch(format: export.kind.apiFormat, conversations: batch)
                latest = ImportSummary(
                    newCanonicalEvents: latest.newCanonicalEvents + s.newCanonicalEvents,
                    newCognitiveEvents: latest.newCognitiveEvents + s.newCognitiveEvents,
                    rejectedExtractions: latest.rejectedExtractions + s.rejectedExtractions,
                    ideaCount: s.ideaCount
                )
            } catch let APIError.http(status, _) where status == 402 {
                return (latest, done)
            }
            done += batch.count
            index += batchSize
            let snapshot = BackfillProgress(conversationsDone: done, conversationsTotal: all.count, ideaCount: latest.ideaCount)
            await MainActor.run { progress(snapshot) }
        }
        return (latest, nil)
    }

    /// Cursor keeps its history in a local `state.vscdb`, so its backfill needs no export -- read
    /// it and send each conversation to `/v1/conversations` (the backend dedupes on message id).
    /// Same progress + 402 handling as `run`.
    static func runCursor(
        client: APIClient,
        progress: @escaping (BackfillProgress) -> Void
    ) async throws -> (summary: ImportSummary, cappedAt: Int?) {
        let convs = CursorBackfill.readConversations()
        guard !convs.isEmpty else { throw BackfillError.emptyExport }

        let iso = ISO8601DateFormatter()
        var done = 0
        var lastIdeaCount = 0
        for c in convs {
            let base = Date()
            let messages = c.messages.enumerated().map { i, m in
                (id: "\(c.id)::\(i)", role: m.role, text: m.text,
                 createdAt: iso.string(from: base.addingTimeInterval(Double(i))))
            }
            do {
                lastIdeaCount = try await client.ingestConversation(id: c.id, source: "cursor", messages: messages).ideaCount
            } catch let APIError.http(status, _) where status == 402 {
                return (ImportSummary(newCanonicalEvents: 0, newCognitiveEvents: 0, rejectedExtractions: 0, ideaCount: lastIdeaCount), done)
            }
            done += 1
            let snap = BackfillProgress(conversationsDone: done, conversationsTotal: convs.count, ideaCount: lastIdeaCount)
            await MainActor.run { progress(snap) }
        }
        return (ImportSummary(newCanonicalEvents: 0, newCognitiveEvents: 0, rejectedExtractions: 0, ideaCount: lastIdeaCount), nil)
    }

    // MARK: - helpers

    /// Returns a URL to a readable `conversations.json` -- the file itself if `url` already is
    /// one, otherwise an extracted copy in a fresh temp dir the caller cleans up.
    private static func materializeConversationsJson(_ url: URL) throws -> URL {
        if url.pathExtension.lowercased() == "json" { return url }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("thread-backfill-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        _ = shell("/usr/bin/unzip", ["-o", "-j", url.path, "conversations.json", "-d", tmp.path], maxBytes: 0)
        let out = tmp.appendingPathComponent("conversations.json")
        guard FileManager.default.fileExists(atPath: out.path) else { throw BackfillError.notAnExport }
        return out
    }

    private static func zipContainsConversationsJson(_ url: URL) -> Bool {
        (shell("/usr/bin/unzip", ["-l", url.path], maxBytes: 65_536) ?? "").contains("conversations.json")
    }

    private static func roughZipConversationCount(_ url: URL, kind: BackfillKind) -> Int {
        // Stream the entry and count top-level object openers -- imprecise but bounded, and only
        // used for the pre-run "~N" label.
        let text = shell("/usr/bin/unzip", ["-p", url.path, "conversations.json"], maxBytes: 4_000_000) ?? ""
        let needle = kind == .chatgpt ? "\"current_node\"" : "\"chat_messages\""
        return max(text.components(separatedBy: needle).count - 1, 1)
    }

    @discardableResult
    private static func shell(_ launch: String, _ args: [String], maxBytes: Int) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: launch)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let data: Data
        if maxBytes > 0 {
            data = pipe.fileHandleForReading.readData(ofLength: maxBytes)
            p.terminationHandler = { _ in }
            try? pipe.fileHandleForReading.close()
            p.waitUntilExit()
        } else {
            data = pipe.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
        }
        return String(data: data, encoding: .utf8)
    }
}
