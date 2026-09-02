import Foundation
import Network

/// The Mac app is the account authority. While it holds credentials, it serves them on a
/// loopback-only HTTP endpoint so the browser extension can adopt them with no copy-paste --
/// `GET http://127.0.0.1:43917/thread/pair`. Bound to 127.0.0.1 explicitly, so nothing off the
/// machine can reach it; the response only ever contains this user's own credentials, which the
/// extension would otherwise get by the user pasting a pairing string.
///
/// SECURITY: the response carries a bearer token, so it sends **no** CORS headers. The MV3
/// extension reads it from its background worker through a `http://127.0.0.1/*` host permission,
/// which isn't gated by CORS. With no `Access-Control-Allow-Origin`, the browser refuses to let
/// a cross-origin web page read the body -- which is what stops any page the user visits from
/// `fetch`-ing this endpoint and walking off with the token.
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
    init(payloadProvider: @escaping () -> Data?, onServed: @escaping () -> Void = {}) {
        self.payloadProvider = payloadProvider
        self.onServed = onServed
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
            let requestLine = data.flatMap { String(data: $0, encoding: .utf8) }?
                .split(separator: "\r\n").first.map(String.init) ?? ""
            let response = self.response(for: requestLine)
            conn.send(content: response, completion: .contentProcessed { _ in conn.cancel() })
        }
    }

    private func response(for requestLine: String) -> Data {
        let parts = requestLine.split(separator: " ")
        let method = parts.first.map(String.init) ?? ""
        let path = parts.count > 1 ? String(parts[1]) : ""

        guard method == "GET", path == "/thread/pair", let body = payloadProvider() else {
            return Self.raw(status: "404 Not Found", body: Data(#"{"error":"not pairing"}"#.utf8))
        }
        onServed()
        return Self.raw(status: "200 OK", body: body)
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
