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
        guard let url = URL(string: baseURL + path) else {
            throw APIError.http(status: 0, message: "Invalid URL: \(baseURL + path)")
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

    static func createUser(baseURL: String, session: URLSession = .shared) async throws -> CreatedUser {
        let client = APIClient(baseURL: baseURL, credentials: nil, session: session)
        return try await client.request("/v1/users", method: "POST")
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
        let body = try JSONEncoder().encode(["email": email, "code": code])
        return try await client.request("/v1/auth/verify", method: "POST", body: body)
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

    func traceIdea(id: String) async throws -> IdeaTrace {
        try await request("/v1/ideas/\(id)/trace")
    }

    func renameIdea(id: String, title: String) async throws -> IdeaDetail {
        let body = try JSONEncoder().encode(["title": title])
        return try await request("/v1/ideas/\(id)", method: "PATCH", body: body)
    }

    func setIdeaState(id: String, state: String) async throws -> IdeaDetail {
        let body = try JSONEncoder().encode(["state": state])
        return try await request("/v1/ideas/\(id)", method: "PATCH", body: body)
    }

    func deleteIdea(id: String) async throws {
        struct Empty: Decodable {}
        let _: Empty = try await request("/v1/ideas/\(id)", method: "DELETE")
    }

    func setOpenLoopResolved(id: String, resolved: Bool) async throws {
        struct Empty: Decodable {}
        let body = try JSONEncoder().encode(["resolved": resolved])
        let _: Empty = try await request("/v1/open-loops/\(id)", method: "PATCH", body: body)
    }

    func continueThinking(topic: String) async throws -> ContinueResponse {
        let body = try JSONEncoder().encode(["topic": topic])
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
