import Foundation
import Network

/// The Mac app is the account authority. It serves its credentials on a loopback-only HTTP
/// endpoint so the browser extension can adopt them with no copy-paste --
/// `GET http://127.0.0.1:43917/thread/pair`. Bound to 127.0.0.1 explicitly, so nothing off the
/// machine can reach it; the response only ever contains this user's own credentials, which the
/// extension would otherwise get by the user pasting a pairing string.
///
/// The endpoint answers with the token **only while a pairing window is open** (~2 min after
/// launch, or when the user clicks "Connect a browser"); outside it, 404. `payloadProvider`
/// returns nil then. That bounds how long the token sits reachable on the wire.
///
/// SECURITY: the response carries a bearer token, so it sends **no** CORS headers. The MV3
/// extension reads it from its background worker through a `http://127.0.0.1/*` host permission,
/// which isn't gated by CORS. With no `Access-Control-Allow-Origin`, the browser refuses to let
/// a cross-origin web page read the body -- which is what stops any page the user visits from
/// `fetch`-ing this endpoint and walking off with the token.
///
/// CORS alone doesn't stop DNS rebinding: a page on `evil.example` that re-resolves its own name
/// to 127.0.0.1 is *same-origin* with this server and could read the body. So every request must
/// also name this server in `Host` (127.0.0.1 / localhost on our port), and any `Origin` a browser
/// attaches must be the extension's own (`chrome-extension://…`, `moz-extension://…`,
/// `safari-web-extension://…`) -- web origins are refused outright. See `isTrusted(headers:)`.
///
/// Deliberately tiny: enough HTTP/1.1 to answer one GET. No routing framework, no dependencies.
final class PairingServer {
    static let port: UInt16 = 43917

    private var listener: NWListener?
    private let queue = DispatchQueue(label: "com.thread.mac.pairing-server")
    private var payloadProvider: () -> Data?
    private var onServed: () -> Void

    /// - Parameters:
    ///   - payloadProvider: the JSON body to serve, or nil to answer 404 (app not paired yet).
    ///   - onServed: called after credentials are successfully handed to a client -- used to
    ///     surface "browser connected" in the UI. Invoked on an arbitrary queue.
    ///   - onHello: called when the extension pings `GET /thread/hello?userId=…` to announce it
    ///     is connected (it does this after adopting credentials by *any* path, including a
    ///     pasted code, which never touches `/thread/pair`). The argument is the userId it
    ///     claims; the app ignores a ping for a different account. Invoked on an arbitrary queue.
    ///     `captured` is true when the ping follows a capture the server just confirmed
    ///     (`&captured=1`) -- the app refreshes right away instead of waiting for its next sync.
    private var onHello: (_ userId: String?, _ captured: Bool) -> Void
    init(
        payloadProvider: @escaping () -> Data?,
        onServed: @escaping () -> Void = {},
        onHello: @escaping (_ userId: String?, _ captured: Bool) -> Void = { _, _ in }
    ) {
        self.payloadProvider = payloadProvider
        self.onServed = onServed
        self.onHello = onHello
    }

    func start() {
        guard listener == nil else { return }
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: PairingServer.port)!)
        params.allowLocalEndpointReuse = true

        do {
            let listener = try NWListener(using: params)
            self.listener = listener
            listener.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
            listener.stateUpdateHandler = { state in
                if case .failed(let err) = state {
                    print("[ThreadMac] pairing server failed: \(err)")
                }
            }
            listener.start(queue: queue)
            print("[ThreadMac] pairing server listening on 127.0.0.1:\(PairingServer.port)")
        } catch {
            print("[ThreadMac] could not start pairing server: \(error)")
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func handle(_ conn: NWConnection) {
        conn.start(queue: queue)
        conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
            guard let self else { conn.cancel(); return }
            let lines = data.flatMap { String(data: $0, encoding: .utf8) }?
                .components(separatedBy: "\r\n") ?? []
            let requestLine = lines.first ?? ""
            let response = Self.isTrusted(headers: Self.headers(from: lines.dropFirst()))
                ? self.response(for: requestLine)
                : Self.raw(status: "403 Forbidden", body: Data(#"{"error":"forbidden"}"#.utf8))
            conn.send(content: response, completion: .contentProcessed { _ in conn.cancel() })
        }
    }

    func response(for requestLine: String) -> Data {   // internal for tests
        let parts = requestLine.split(separator: " ")
        let method = parts.first.map(String.init) ?? ""
        let path = parts.count > 1 ? String(parts[1]) : ""

        // Liveness ping -- no token in or out. Answered any time (no pairing window needed) so a
        // browser that paired via a pasted code can still register as connected.
        if method == "GET", path.hasPrefix("/thread/hello") {
            onHello(Self.queryValue("userId", in: path), Self.queryValue("captured", in: path) == "1")
            return Self.raw(status: "200 OK", body: Data(#"{"ok":true}"#.utf8))
        }

        guard method == "GET", path == "/thread/pair", let body = payloadProvider() else {
            return Self.raw(status: "404 Not Found", body: Data(#"{"error":"not pairing"}"#.utf8))
        }
        onServed()
        return Self.raw(status: "200 OK", body: body)
    }

    /// Lower-cased header name -> value, up to the blank line that ends the header block.
    static func headers<S: Sequence>(from lines: S) -> [String: String] where S.Element == String {
        var out: [String: String] = [:]
        for line in lines {
            if line.isEmpty { break }
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            out[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        return out
    }

    /// DNS-rebinding guard (see the type doc). `Host` must be loopback on our port; an `Origin`,
    /// when present, must be a browser-extension origin. A missing `Origin` is fine -- that's a
    /// native client or the extension's service worker on browsers that omit it for GETs.
    static func isTrusted(headers: [String: String]) -> Bool {
        let allowedHosts: Set<String> = ["127.0.0.1:\(port)", "localhost:\(port)", "[::1]:\(port)"]
        guard let host = headers["host"]?.lowercased(), allowedHosts.contains(host) else { return false }
        if let origin = headers["origin"]?.lowercased(), origin != "null" {
            let extensionSchemes = ["chrome-extension://", "moz-extension://", "safari-web-extension://"]
            return extensionSchemes.contains { origin.hasPrefix($0) }
        }
        return true
    }

    /// Pull `?key=value` out of a request path. Minimal -- enough for the one param `/thread/hello`
    /// carries. Percent-decodes the value.
    private static func queryValue(_ key: String, in path: String) -> String? {
        guard let q = path.split(separator: "?").dropFirst().first else { return nil }
        for pair in q.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1)
            if kv.first.map(String.init) == key {
                return kv.count > 1 ? String(kv[1]).removingPercentEncoding ?? String(kv[1]) : ""
            }
        }
        return nil
    }

    private static func raw(status: String, body: Data?) -> Data {
        // No CORS headers, on purpose -- see the type doc. The extension reaches this via a
        // host permission, not a page fetch, so it needs none; omitting them is what keeps a
        // hostile web page from reading a token response it manages to trigger.
        var headers = "HTTP/1.1 \(status)\r\n"
        headers += "Cache-Control: no-store\r\n"
        headers += "Content-Type: application/json\r\n"
        headers += "Content-Length: \(body?.count ?? 0)\r\n"
        headers += "Connection: close\r\n\r\n"
        var out = Data(headers.utf8)
        if let body { out.append(body) }
        return out
    }
}
