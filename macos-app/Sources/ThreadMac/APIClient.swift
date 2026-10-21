import Foundation

enum APIError: Error, LocalizedError {
    case http(status: Int, message: String)
    case network(Error)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .http(let status, let message): return "\(status): \(message)"
        case .network(let err): return "Network error: \(err.localizedDescription)"
        case .decoding(let err): return "Decoding error: \(err.localizedDescription)"
        }
    }
}

/// Talks to the same backend the browser extension and desktop agent use (src/api). No
/// business logic lives here beyond request/response plumbing -- identical in spirit to
/// extension/src/lib/api.ts, just in Swift. `session` is injectable so tests never hit the
/// network unless they explicitly want to (see APIClientTests.swift).
final class APIClient {
    private let baseURL: String
    private let credentials: (userId: String, token: String)?
    private let session: URLSession
    private let decoder: JSONDecoder

    init(baseURL: String, credentials: (userId: String, token: String)?, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.credentials = credentials
        self.session = session
        self.decoder = JSONDecoder()
    }

    /// True when this process is a test run (XCTest sets this and loads its bundle).
    static let isRunningTests: Bool =
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
        || NSClassFromString("XCTestCase") != nil

    private func rawRequest(_ path: String, method: String = "GET", body: Data? = nil, timeout: TimeInterval? = nil) async throws -> Data {
        // A base URL with no scheme (e.g. a bare host typed into Settings) still yields a non-nil
        // *relative* URL here, which URLSession then rejects with the opaque "unsupported URL".
        // Catch it with a clear message instead.
        guard let url = URL(string: baseURL + path), let scheme = url.scheme, scheme.hasPrefix("http"), url.host != nil else {
            throw APIError.http(status: 0, message: "Thread can't reach its server address. Reinstall Thread from threadnow.app to reset it.")
        }
        // A test run never reaches the real server. Tests that exercise this client pass their own
        // stubbed session (MockURLProtocol); anything on the shared session is a test that built an
        // AppState and would otherwise call production with the developer's own Keychain sign-in,
        // as an "install" running the test runner's version.
        if Self.isRunningTests && session === URLSession.shared {
            throw APIError.http(status: 0, message: "Tests don't reach the network.")
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        if let timeout { req.timeoutInterval = timeout }
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        // Which build is talking: lets the server count active installs by version (so old ones
        // that can't self-update are visible). Version only -- nothing about the person.
        if let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
            req.setValue("ThreadMac/\(v)", forHTTPHeaderField: "x-thread-app")
        }
        // One Mac = one install, across sign-outs (InstallIdentity), and which macOS it runs.
        req.setValue(InstallIdentity.id(), forHTTPHeaderField: "x-thread-install")
        req.setValue(InstallIdentity.osVersion, forHTTPHeaderField: "x-thread-os")
        if let credentials {
            req.setValue("Bearer \(credentials.userId):\(credentials.token)", forHTTPHeaderField: "authorization")
        }
        req.httpBody = body

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw APIError.network(error)
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            let message = (try? decoder.decode(APIErrorBody.self, from: data))?.error ?? "Request failed"
            throw APIError.http(status: status, message: message)
        }

        return data
    }

    private func request<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil) async throws -> T {
        let data = try await rawRequest(path, method: method, body: body)
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }

    /// The label this device carries in the account's session list. The browser extension adopts
    /// this same token via the local pairing server, so the one label names both.
    static let deviceName = "Thread for Mac (+ browser)"

    static func createUser(baseURL: String, session: URLSession = .shared) async throws -> CreatedUser {
        let client = APIClient(baseURL: baseURL, credentials: nil, session: session)
        let body = try JSONEncoder().encode(["deviceName": deviceName])
        return try await client.request("/v1/users", method: "POST", body: body)
    }

    // MARK: - Passwordless sign-in (email + 6-digit code)

    struct OKResponse: Decodable { let ok: Bool? }

    static func authStart(baseURL: String, email: String, session: URLSession = .shared) async throws {
        let client = APIClient(baseURL: baseURL, credentials: nil, session: session)
        let body = try JSONEncoder().encode(["email": email])
        let _: OKResponse = try await client.request("/v1/auth/start", method: "POST", body: body)
    }

    static func authVerify(baseURL: String, email: String, code: String, session: URLSession = .shared) async throws -> CreatedUser {
        let client = APIClient(baseURL: baseURL, credentials: nil, session: session)
        let body = try JSONEncoder().encode(["email": email, "code": code, "deviceName": deviceName])
        return try await client.request("/v1/auth/verify", method: "POST", body: body)
    }

    // MARK: - Device sessions

    struct RevokedResponse: Decodable { let revoked: Int }

    /// Sign this device out server-side (revoke exactly this token). Best-effort at unpair time.
    func signOutThisDevice() async throws {
        struct Empty: Decodable {}
        let _: Empty = try await request("/v1/auth/session", method: "DELETE")
    }

    /// Sign out every other device on this account; this one keeps working.
    @discardableResult
    func signOutOtherDevices() async throws -> Int {
        let r: RevokedResponse = try await request("/v1/auth/sessions/revoke-others", method: "POST")
        return r.revoked
    }

    /// Claim the current (bearer-authed) account by attaching a verified email.
    func accountEmailStart(email: String) async throws {
        let body = try JSONEncoder().encode(["email": email])
        let _: OKResponse = try await request("/v1/account/email", method: "POST", body: body)
    }

    func accountEmailVerify(email: String, code: String) async throws -> AccountStatus {
        let body = try JSONEncoder().encode(["email": email, "code": code])
        return try await request("/v1/account/email/verify", method: "POST", body: body)
    }

    func getThinkingState(topic: String? = nil) async throws -> ThinkingStateResponse {
        var path = "/v1/thinking-state"
        if let topic, !topic.isEmpty {
            path += "?topic=" + (topic.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? topic)
        }
        return try await request(path)
    }

    /// "What do I think about X?" -- ranked by meaning on the server, answered in the person's words.
    func ask(_ query: String) async throws -> AskAnswer {
        let q = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        return try await request("/v1/ask?q=\(q)")
    }

    func searchIdeas(query: String) async throws -> [SearchResult] {
        let q = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        return try await request("/v1/ideas?q=\(q)")
    }

    /// Is capture actually working, over the last week. Per-user, not admin-gated.
    func captureHealth() async throws -> CaptureHealth {
        try await request("/v1/capture-health")
    }

    /// Idea/loop ids can contain `:` (paste-sourced ids look like `<conv>::<n>`), which
    /// URLSession rejects raw in a path with "unsupported URL". Encode to RFC 3986 unreserved
    /// only; the backend decodeURIComponent's it back.
    private static func pathSegment(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    func traceIdea(id: String) async throws -> IdeaTrace {
        try await request("/v1/ideas/\(Self.pathSegment(id))/trace")
    }

    /// Options weighed and unfinished-thinking gaps for one idea.
    func thinkingMap(id: String) async throws -> ThinkingMap {
        struct Wrap: Decodable { let map: ThinkingMap }
        let w: Wrap = try await request("/v1/ideas/\(Self.pathSegment(id))/map")
        return w.map
    }

    /// The captured messages of one source conversation -- the evidence behind an idea.
    func getConversation(id: String) async throws -> ConversationTranscript {
        try await request("/v1/conversations/\(Self.pathSegment(id))")
    }

    /// Every conversation Thread has captured, newest first -- the "Activity" feed.
    func listConversations() async throws -> [ConversationSummary] {
        struct Wrap: Decodable { let conversations: [ConversationSummary] }
        let w: Wrap = try await request("/v1/conversations")
        return w.conversations
    }

    // MARK: - Your data

    func dataSummary() async throws -> DataSummaryResponse {
        try await request("/v1/account/data-summary")
    }

    /// A full copy of everything Thread holds for this account, as the server's JSON.
    func exportData() async throws -> Data {
        // A full copy of a large account can take well over the 60s default -- and a timeout here
        // used to look like the button doing nothing.
        try await rawRequest("/v1/account/export", timeout: 600)
    }

    /// Remove one conversation and everything derived from it.
    func deleteConversation(id: String) async throws -> ConversationRemoval {
        try await request("/v1/conversations/\(Self.pathSegment(id))", method: "DELETE")
    }

    /// Delete the account and all of its data. The server insists on the typed confirmation and
    /// answers 409 `subscription_active` while a paid plan is live unless acknowledged.
    func deleteEverything(acknowledgeSubscription: Bool) async throws -> AccountDeletionReceipt {
        struct Body: Encodable { let confirm: String; let acknowledgeSubscription: Bool }
        let body = try JSONEncoder().encode(Body(confirm: "delete everything", acknowledgeSubscription: acknowledgeSubscription))
        return try await request("/v1/account/data", method: "DELETE", body: body)
    }

    /// Historical backfill: one batch of an exported `conversations.json` array. `conversations`
    /// is the raw JSON objects, sliced by the caller into batches; the backend parses + ingests.
    func importBatch(format: String, conversations: [Any]) async throws -> ImportSummary {
        // On-device first pass: credentials never leave the Mac.
        let payload: [String: Any] = ["format": format, "conversations": conversations.map(Redaction.redactDeep)]
        let body = try JSONSerialization.data(withJSONObject: payload)
        return try await request("/v1/import", method: "POST", body: body)
    }

    func renameIdea(id: String, title: String) async throws -> IdeaDetail {
        let body = try JSONEncoder().encode(["title": title])
        return try await request("/v1/ideas/\(Self.pathSegment(id))", method: "PATCH", body: body)
    }

    func setIdeaState(id: String, state: String) async throws -> IdeaDetail {
        let body = try JSONEncoder().encode(["state": state])
        return try await request("/v1/ideas/\(Self.pathSegment(id))", method: "PATCH", body: body)
    }

    struct CorrectionRecorded: Decodable { let recorded: Bool? }

    /// "These two are one idea": the server remembers it and regroups. Every later pass respects it.
    func mergeIdea(id: String, into otherId: String) async throws {
        let body = try JSONEncoder().encode(["intoIdeaId": otherId])
        let _: CorrectionRecorded = try await request("/v1/ideas/\(Self.pathSegment(id))/merge", method: "POST", body: body)
    }

    /// "These thoughts are a different idea": some, not all, of the idea's thoughts.
    func splitIdea(id: String, thoughtIds: [String]) async throws {
        let body = try JSONEncoder().encode(["thoughtIds": thoughtIds])
        let _: CorrectionRecorded = try await request("/v1/ideas/\(Self.pathSegment(id))/split", method: "POST", body: body)
    }

    /// "Keep": the person confirms an idea is worth having (`DELETE` is "not an idea").
    func keepIdea(id: String) async throws {
        let body = try JSONEncoder().encode(["verdict": "keep"])
        let _: IdeaDetail = try await request("/v1/ideas/\(Self.pathSegment(id))", method: "PATCH", body: body)
    }

    /// What Thread has learned about which ideas this person keeps.
    func getTaste() async throws -> TasteReport {
        try await request("/v1/taste")
    }

    /// Teach Thread: the questions that would teach Thread the most right now.
    func getLesson() async throws -> Lesson {
        try await request("/v1/learn")
    }

    /// One Teach Thread answer; returns the updated lesson (what's left, what's been learned).
    func answerLesson(_ body: [String: String]) async throws -> Lesson {
        try await request("/v1/learn/answer", method: "POST", body: try JSONEncoder().encode(body))
    }

    func deleteIdea(id: String) async throws {
        struct Empty: Decodable {}
        let _: Empty = try await request("/v1/ideas/\(Self.pathSegment(id))", method: "DELETE")
    }

    func setOpenLoopResolved(id: String, resolved: Bool) async throws {
        struct Empty: Decodable {}
        let body = try JSONEncoder().encode(["resolved": resolved])
        let _: Empty = try await request("/v1/open-loops/\(Self.pathSegment(id))", method: "PATCH", body: body)
    }

    /// Build the continuation packet for one specific idea (exact id -- what the app always has).
    func continueIdea(ideaId: String) async throws -> ContinueResponse {
        let body = try JSONEncoder().encode(["ideaId": ideaId])
        return try await request("/v1/continue", method: "POST", body: body)
    }

    func pasteConversation(text: String) async throws -> IngestResult {
        let body = try JSONEncoder().encode(["text": Redaction.redact(text)])
        return try await request("/v1/paste", method: "POST", body: body)
    }

    /// Ingest one structured conversation (used by the on-Mac Cursor history pass and the live AX
    /// sensor -- the browser extension has its own path). The backend dedupes on message id, so
    /// re-sending is free.
    ///
    /// `capture` stamps the provenance: which sensor observed this and how much to trust it
    /// (`method` in CaptureMethod, `fidelity` high|medium|low). Omit it and the backend reads the
    /// row as `browser_extension`/`high` -- so a native capture that leaves this nil is
    /// indistinguishable from extension traffic. `sourceUrl` is an optional "view source" anchor.
    func ingestConversation(
        id: String,
        source: String,
        messages: [(id: String, role: String, text: String, createdAt: String)],
        capture: (method: String, fidelity: String)? = nil,
        sourceUrl: String? = nil
    ) async throws -> IngestResult {
        var payload: [String: Any] = [
            "conversationId": id,
            "source": source,
            "messages": messages.map { ["id": $0.id, "role": $0.role, "text": Redaction.redact($0.text), "createdAt": $0.createdAt] },
        ]
        if let capture { payload["capture"] = ["method": capture.method, "fidelity": capture.fidelity] }
        if let sourceUrl { payload["sourceUrl"] = sourceUrl }
        let body = try JSONSerialization.data(withJSONObject: payload)
        return try await request("/v1/conversations", method: "POST", body: body)
    }

    // MARK: - Thought vectors (on-device embeddings for server-side mining)

    struct PendingThought: Decodable { let id: String; let text: String }

    func thoughtsNeedingVectors(model: String, limit: Int) async throws -> [PendingThought] {
        struct Wrap: Decodable { let thoughts: [PendingThought] }
        let m = model.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? model
        let w: Wrap = try await request("/v1/thoughts/unembedded?model=\(m)&limit=\(limit)")
        return w.thoughts
    }

    func uploadThoughtVectors(model: String, items: [(id: String, vector: [Float])]) async throws {
        struct Stored: Decodable { let stored: Int }
        let payload: [String: Any] = [
            "model": model,
            "items": items.map { ["id": $0.id, "vector": $0.vector.map { Double($0) }] as [String: Any] },
        ]
        let body = try JSONSerialization.data(withJSONObject: payload)
        let _: Stored = try await request("/v1/thoughts/embeddings", method: "POST", body: body)
    }

    func getAccount() async throws -> AccountStatus {
        try await request("/v1/account")
    }

    func billingPortalURL() async throws -> URL {
        let r: BillingURL = try await request("/v1/billing/portal")
        guard let u = URL(string: r.url) else { throw APIError.http(status: 0, message: "Bad portal URL") }
        return u
    }
}

// Every stored property is an immutable `let` set at init, so sharing one across tasks/actors
// (thought-vector sync runs off the main actor) is safe.
extension APIClient: @unchecked Sendable {}
