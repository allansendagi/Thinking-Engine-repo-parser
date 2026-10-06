import Foundation

/// One message read from an AI tool's own history files.
struct LocalMessage: Equatable {
    let id: String
    let role: String        // "user" | "assistant"
    let text: String
    let createdAt: String   // ISO-8601
}

/// One conversation read from disk. `id` is the tool's own session id, so re-reading the same
/// file always maps to the same Thread conversation.
struct LocalConversation: Equatable {
    let id: String
    let messages: [LocalMessage]
}

/// An AI tool that keeps its conversations in readable files on this Mac (CLIs, editors, local
/// model apps). Each one is a small pure parser; `LocalHistoryWatch` does the watching, the
/// diffing and the sending for all of them.
protocol LocalHistorySource: Sendable {
    /// The `source` stamped on captures ("claude_code", "codex", ...).
    var source: String { get }
    /// Shown in Settings and capture health.
    var displayName: String { get }
    /// Folders to watch. Missing ones are fine (tool not installed yet).
    var roots: [String] { get }
    /// Is this changed file one of the tool's conversation files?
    func isConversationFile(_ path: String) -> Bool
    /// Parse one conversation file. Nil when it isn't a conversation (or is unreadable).
    func read(_ path: String) -> LocalConversation?
}

extension LocalHistorySource {
    var home: String { FileManager.default.homeDirectoryForCurrentUser.path }
}

/// Native, event-driven capture of every local AI history: one FSEvents stream over all tools'
/// folders; a burst of writes (a reply streaming in) is coalesced by FSEvents and debounced
/// again here, then only the changed files are re-read.
///
/// Same contract as `CursorLiveWatch`, proven there:
///  - **Seeds silently.** The first time a file is seen, its current state is recorded and
///    nothing is sent -- old history is "Recover my thinking"'s job, never a surprise bill.
///  - **Whole conversation, server dedupes.** A changed conversation is POSTed whole; the backend
///    dedupes on message id, so only genuinely new turns are extracted.
///  - **Per account.** A different signed-in account re-seeds instead of inheriting marks.
///  - **402 stops quietly**, transient errors retry on the next change or the periodic sweep.
@MainActor
final class LocalHistoryWatch {
    private let sources: [any LocalHistorySource]
    private let makeClient: @MainActor () -> APIClient
    private let paired: @MainActor () -> Bool
    private let enabled: @MainActor (String) -> Bool
    private let onCaptured: @MainActor (_ source: String) -> Void
    private var stream: FileEventStream?
    private var pending = Set<String>()
    private var debounce: Task<Void, Never>?
    private var sweep: Task<Void, Never>?
    private var watchedRoots: [String] = []
    private var capped = false

    /// file path -> size@mtime when last handled; conversation key -> fingerprint last sent.
    private var fileSigs: [String: String]
    private var sent: [String: String]
    private var owner: String?
    private let sigsKey = "thread.localHistory.fileSigs"
    private let sentKey = "thread.localHistory.sent"
    private let ownerKey = "thread.localHistory.owner"

    init(
        sources: [any LocalHistorySource],
        client: @escaping @MainActor () -> APIClient,
        paired: @escaping @MainActor () -> Bool,
        enabled: @escaping @MainActor (String) -> Bool = { _ in true },
        onCaptured: @escaping @MainActor (String) -> Void = { _ in }
    ) {
        self.sources = sources
        self.makeClient = client
        self.paired = paired
        self.enabled = enabled
        self.onCaptured = onCaptured
        let d = UserDefaults.standard
        fileSigs = (d.dictionary(forKey: sigsKey) as? [String: String]) ?? [:]
        sent = (d.dictionary(forKey: sentKey) as? [String: String]) ?? [:]
        owner = d.string(forKey: ownerKey)
    }

    func start() {
        guard stream == nil else { return }
        let s = FileEventStream { [weak self] paths in
            Task { @MainActor in self?.noteChanged(paths) }
        }
        stream = s
        rewatchIfRootsChanged(force: true)
        // Seed/catch up once at launch, then a slow sweep: picks up a tool installed later (new
        // root to watch) and anything missed while offline. Cheap -- stat-gated per file.
        sweep = Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            while !Task.isCancelled {
                guard let self else { return }
                self.rewatchIfRootsChanged(force: false)
                await self.scanAll()
                try? await Task.sleep(for: .seconds(600))
            }
        }
    }

    func stop() {
        stream?.stop()
        stream = nil
        debounce?.cancel()
        sweep?.cancel()
    }

    /// Which tools are installed (have history on this Mac) -- for Settings.
    func detectedSources() -> [(source: String, name: String)] {
        sources.filter { $0.roots.contains { FileManager.default.fileExists(atPath: $0) } }
            .map { ($0.source, $0.displayName) }
    }

    // MARK: - events

    private func rewatchIfRootsChanged(force: Bool) {
        let roots = sources.flatMap(\.roots).filter { FileManager.default.fileExists(atPath: $0) }
        guard force || roots != watchedRoots else { return }
        watchedRoots = roots
        stream?.watch(roots)
    }

    private func noteChanged(_ paths: [String]) {
        pending.formUnion(paths)
        debounce?.cancel()
        // A reply streaming in rewrites its file repeatedly; wait for a quiet moment.
        debounce = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self, !Task.isCancelled else { return }
            let batch = self.pending
            self.pending.removeAll()
            await self.process(Array(batch))
        }
    }

    private func scanAll() async {
        var files: [String] = []
        for src in sources where enabled(src.source) {
            for root in src.roots {
                guard let e = FileManager.default.enumerator(atPath: root) else { continue }
                while let rel = e.nextObject() as? String {
                    let p = (root as NSString).appendingPathComponent(rel)
                    if src.isConversationFile(p) { files.append(p) }
                }
            }
        }
        await process(files)
    }

    // MARK: - the pump

    private func process(_ paths: [String]) async {
        guard !capped, paired(), let account = CredentialStore.userId else { return }
        if account != owner {
            fileSigs = [:]
            sent = [:]
            owner = account
        }
        var changedAny = false
        for path in Set(paths).sorted() {
            guard let src = sources.first(where: { $0.isConversationFile(path) }), enabled(src.source) else { continue }
            let sig = Self.signature(path)
            let firstSight = fileSigs[path] == nil
            guard sig != fileSigs[path] else { continue }
            // Parse off the main actor -- some histories are large.
            guard let conv = await Task.detached(priority: .utility, operation: { src.read(path) }).value else {
                fileSigs[path] = sig
                continue
            }
            let key = "\(src.source):\(conv.id)"
            let fp = Self.fingerprint(conv)
            if firstSight && sent[key] == nil {
                // Seed: existing history is not captured retroactively.
                fileSigs[path] = sig
                sent[key] = fp
                changedAny = true
                continue
            }
            guard sent[key] != fp, !conv.messages.isEmpty else { fileSigs[path] = sig; continue }
            do {
                _ = try await makeClient().ingestConversation(
                    id: "\(src.source)_\(conv.id)", source: src.source,
                    messages: conv.messages.map { (id: $0.id, role: $0.role, text: $0.text, createdAt: $0.createdAt) },
                    capture: (method: "desktop_agent", fidelity: "high")
                )
                fileSigs[path] = sig
                sent[key] = fp
                changedAny = true
                onCaptured(src.source)
            } catch let APIError.http(status, _) where status == 402 {
                capped = true   // Free cap: stop until relaunch (an upgrade lifts it).
                break
            } catch {
                // Transient: leave the marks so the next change or sweep retries.
            }
        }
        if changedAny { persist() }
    }

    private func persist() {
        let d = UserDefaults.standard
        d.set(fileSigs, forKey: sigsKey)
        d.set(sent, forKey: sentKey)
        d.set(owner, forKey: ownerKey)
    }

    // MARK: - pure helpers (unit-tested)

    nonisolated static func fingerprint(_ c: LocalConversation) -> String {
        "\(c.messages.count):\(c.messages.last?.id ?? ""):\(c.messages.last?.text.count ?? 0)"
    }

    nonisolated static func signature(_ path: String) -> String {
        guard let a = try? FileManager.default.attributesOfItem(atPath: path) else { return "-" }
        let size = (a[.size] as? Int) ?? 0
        let mod = (a[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        return "\(size)@\(mod)"
    }
}
