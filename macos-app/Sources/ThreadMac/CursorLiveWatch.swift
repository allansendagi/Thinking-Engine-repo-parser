import Foundation

/// Continuous capture from Cursor's local store. `CursorBackfill` is the one-shot "read every
/// composer"; this is the same reader on a "diff since last read" loop -- new thinking in Cursor
/// reaches Thread within a poll interval, no export and no Accessibility.
///
/// Mechanism: a low-priority timer re-checks `state.vscdb` (+ its `-wal`). A `stat` signature
/// gates the actual work, so an idle tick is nearly free. When the db has moved, every
/// conversation whose turn set has grown since we last sent it is POSTed **whole** to
/// `/v1/conversations`, stamped `desktop_agent` / `high`. The backend dedupes on canonical event
/// id, so re-sending the settled turns is a cheap no-op there too -- only the genuinely new turn
/// is extracted.
///
/// First run for an account **seeds silently**: it records what's already in the store without
/// ingesting any of it. Existing history is the job of the explicit "Recover my thinking"
/// backfill (`Backfill.runCursor` -- progress UI, resumable, 402-aware). This watch is only ever
/// about thinking that happens from now on, so enabling it can't touch model spend retroactively.
///
/// Structured local data is high-fidelity evidence, not a scrape -- but it still flows the normal
/// pipeline (raw evidence -> canonical -> engine -> ideas). Nothing here creates an idea.
@MainActor
final class CursorLiveWatch {
    private let makeClient: @MainActor () -> APIClient
    private let paired: @MainActor () -> Bool
    private let interval: TimeInterval
    /// At most this many changed conversations per tick -- a valve for the first tick after a long
    /// offline gap, when a WAL checkpoint can surface several at once. The rest go next tick.
    private let perTickSendCap = 8

    private var timer: DispatchSourceTimer?
    private var task: Task<Void, Never>?
    private var stopped = false

    /// conversationId -> fingerprint of the turns already sent. See `fingerprint(_:)`.
    private var seen: [String: String]
    private var seeded: Bool
    /// The user id `seen` belongs to. A different signed-in account (same Cursor install =>
    /// same composerIds) must NOT inherit these high-water marks, so a mismatch forces a re-seed.
    private var owner: String?
    /// The `stat` signature of the db at the last completed pump -- skips a re-read when nothing moved.
    private var lastSignature: String

    private let seenKey = "thread.cursor.live.seen"
    private let seededKey = "thread.cursor.live.seeded"
    private let ownerKey = "thread.cursor.live.owner"
    private let sigKey = "thread.cursor.live.sig"

    init(
        client: @escaping @MainActor () -> APIClient,
        paired: @escaping @MainActor () -> Bool,
        interval: TimeInterval = 20
    ) {
        self.makeClient = client
        self.paired = paired
        self.interval = interval
        let d = UserDefaults.standard
        seen = (d.dictionary(forKey: seenKey) as? [String: String]) ?? [:]
        seeded = d.bool(forKey: seededKey)
        owner = d.string(forKey: ownerKey)
        lastSignature = d.string(forKey: sigKey) ?? ""
    }

    func start() {
        guard timer == nil, !stopped else { return }
        // No `CursorBackfill.available` gate: if Cursor is installed later this session the timer
        // is already running and `pump()` picks it up (an absent db just makes each tick a no-op
        // `stat`).
        let t = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        // A few seconds' grace so a cold launch settles before the first (catch-up) read.
        t.schedule(deadline: .now() + 4, repeating: interval)
        t.setEventHandler { [weak self] in Task { @MainActor in self?.tick() } }
        timer = t
        t.resume()
    }

    func stop() {
        stopped = true
        timer?.cancel()
        timer = nil
        task?.cancel()
        task = nil
    }

    // MARK: - loop

    private func tick() {
        guard task == nil, !stopped else { return }   // a pump from the previous tick is still running
        task = Task { @MainActor in
            defer { self.task = nil }
            await self.pump()
        }
    }

    private func pump() async {
        // No account yet -> nothing to send and nothing to seed against. Idle until pairing.
        guard paired(), let account = CredentialStore.userId else { return }

        // Account switched (or first ever run): drop the previous owner's high-water marks so the
        // next block re-seeds silently against the new account rather than skipping conversations
        // it never actually sent.
        if account != owner {
            seen = [:]
            seeded = false
            owner = account
            lastSignature = ""
        }

        let sig = Self.dbSignature()
        guard sig != lastSignature else { return }

        let convs = CursorBackfill.readConversations()
        let plan = Self.plan(convs: convs, seen: seen, seeded: seeded)

        if let seed = plan.seed {
            seen = seed
            seeded = true
            lastSignature = sig
            persist()
            return
        }

        let client = makeClient()
        var allHandled = true
        var sent = 0
        for c in plan.toSend {
            if sent >= perTickSendCap { allHandled = false; break }
            do {
                _ = try await client.ingestConversation(
                    id: c.id, source: "cursor",
                    messages: c.messages.map {
                        (id: $0.bubbleId, role: $0.role, text: $0.text, createdAt: $0.createdAt)
                    },
                    capture: (method: "desktop_agent", fidelity: "high")
                )
                seen[c.id] = plan.fingerprints[c.id]
                sent += 1
            } catch let APIError.http(status, _) where status == 402 {
                // Free-plan capture cap. Stop quietly -- an upgrade + relaunch resumes; hammering
                // a capped account every interval would be pointless noise.
                persist()
                stop()
                return
            } catch {
                // Transient (offline, 5xx). Leave this conversation's `seen` untouched and don't
                // advance `lastSignature`, so the next tick re-reads and retries it.
                allHandled = false
            }
        }
        if allHandled { lastSignature = sig }
        persist()
    }

    private func persist() {
        let d = UserDefaults.standard
        d.set(seen, forKey: seenKey)
        d.set(seeded, forKey: seededKey)
        d.set(owner, forKey: ownerKey)
        d.set(lastSignature, forKey: sigKey)
    }

    // MARK: - pure core (unit-tested)

    struct Plan: Equatable {
        /// Non-nil on the first run: seed `seen` with this and send nothing.
        var seed: [String: String]?
        var toSend: [CursorBackfill.Conversation]
        /// id -> fingerprint for each conversation in `toSend`, applied to `seen` on a successful send.
        var fingerprints: [String: String]
    }

    /// A turn is only ever appended in Cursor's store (a streamed reply lands as one bubble once
    /// its text is final), so "how many text turns, ending on which bubble" uniquely identifies a
    /// conversation's state for our purposes. An in-place edit of an existing turn's text is not
    /// caught -- acceptable for v1; a new turn always is.
    nonisolated static func fingerprint(_ c: CursorBackfill.Conversation) -> String {
        "\(c.messages.count):\(c.messages.last?.bubbleId ?? "")"
    }

    nonisolated static func plan(convs: [CursorBackfill.Conversation], seen: [String: String], seeded: Bool) -> Plan {
        guard seeded else {
            var s: [String: String] = [:]
            for c in convs { s[c.id] = fingerprint(c) }
            return Plan(seed: s, toSend: [], fingerprints: [:])
        }
        var toSend: [CursorBackfill.Conversation] = []
        var fps: [String: String] = [:]
        for c in convs {
            let fp = fingerprint(c)
            guard seen[c.id] != fp else { continue }
            toSend.append(c)
            fps[c.id] = fp
        }
        return Plan(seed: nil, toSend: toSend, fingerprints: fps)
    }

    // MARK: - db signature

    /// size + mtime of `state.vscdb` and its `-wal`, so a tick that finds neither changed does no
    /// work. (WAL mode writes land in `-wal` first and only reach the main file on checkpoint --
    /// both have to be in the signature.)
    nonisolated static func dbSignature() -> String {
        let base = CursorBackfill.stateDbPath
        func part(_ path: String) -> String {
            guard let a = try? FileManager.default.attributesOfItem(atPath: path) else { return "-" }
            let size = (a[.size] as? Int) ?? 0
            let mod = (a[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
            return "\(size)@\(mod)"
        }
        return part(base) + "|" + part(base + "-wal")
    }
}
