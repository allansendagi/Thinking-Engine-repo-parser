import Foundation

/// Intercepts URLSession requests so APIClient tests never touch the real network -- registered
/// on a URLSession built with this protocol class in its configuration.
final class MockURLProtocol: URLProtocol {
    struct Stub {
        let status: Int
        let body: Data
    }

    /// Keyed by "METHOD path" (e.g. "GET /v1/thinking-state") so a test can script exactly what
    /// each expected request should receive.
    nonisolated(unsafe) static var stubs: [String: Stub] = [:]
    nonisolated(unsafe) static var capturedRequests: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        MockURLProtocol.capturedRequests.append(request)

        let method = request.httpMethod ?? "GET"
        let path = request.url?.path ?? ""
        let query = request.url?.query.map { "?\($0)" } ?? ""
        let key = "\(method) \(path)\(query)"

        guard let stub = MockURLProtocol.stubs[key] else {
            let error = NSError(domain: "MockURLProtocol", code: 1, userInfo: [NSLocalizedDescriptionKey: "No stub for \(key)"])
            client?.urlProtocol(self, didFailWithError: error)
            return
        }

        let response = HTTPURLResponse(url: request.url!, statusCode: stub.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: stub.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: config)
    }

    static func reset() {
        stubs = [:]
        capturedRequests = []
    }
}
