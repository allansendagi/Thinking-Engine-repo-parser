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

    private func request<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil) async throws -> T {
        // A base URL with no scheme (e.g. a bare host typed into Settings) still yields a non-nil
        // *relative* URL here, which URLSession then rejects with the opaque "unsupported URL".
        // Catch it with a clear message instead.
        guard let url = URL(string: baseURL + path), let scheme = url.scheme, scheme.hasPrefix("http"), url.host != nil else {
            throw APIError.http(status: 0, message: "Invalid API base URL: \(baseURL) — set it to something like https://api.thread.app in Settings ▸ Advanced.")
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "content-type")
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

    func searchIdeas(query: String) async throws -> [SearchResult] {
        let q = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        return try await request("/v1/ideas?q=\(q)")
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

    func renameIdea(id: String, title: String) async throws -> IdeaDetail {
        let body = try JSONEncoder().encode(["title": title])
        return try await request("/v1/ideas/\(Self.pathSegment(id))", method: "PATCH", body: body)
    }

    func setIdeaState(id: String, state: String) async throws -> IdeaDetail {
        let body = try JSONEncoder().encode(["state": state])
        return try await request("/v1/ideas/\(Self.pathSegment(id))", method: "PATCH", body: body)
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
        let body = try JSONEncoder().encode(["text": text])
        return try await request("/v1/paste", method: "POST", body: body)
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
