import XCTest
@testable import ThreadMac

/// The loopback pairing endpoint hands out a bearer token, so who it answers matters.
final class PairingServerTests: XCTestCase {
    private func headers(_ raw: [String]) -> [String: String] {
        PairingServer.headers(from: raw)
    }

    func testExtensionServiceWorkerIsTrusted() {
        XCTAssertTrue(PairingServer.isTrusted(headers: headers([
            "Host: 127.0.0.1:43917",
            "Origin: chrome-extension://abcdefghijklmnop",
        ])))
        XCTAssertTrue(PairingServer.isTrusted(headers: headers(["Host: localhost:43917"])))
    }

    func testDNSRebindingHostIsRefused() {
        // evil.example re-resolved to 127.0.0.1: the browser still sends its own name as Host.
        XCTAssertFalse(PairingServer.isTrusted(headers: headers([
            "Host: evil.example:43917",
            "Origin: http://evil.example:43917",
        ])))
    }

    func testWebOriginIsRefusedEvenOnLoopbackHost() {
        XCTAssertFalse(PairingServer.isTrusted(headers: headers([
            "Host: 127.0.0.1:43917",
            "Origin: https://some-site.example",
        ])))
    }

    func testMissingHostIsRefused() {
        XCTAssertFalse(PairingServer.isTrusted(headers: headers(["Origin: chrome-extension://x"])))
    }

    func testHeaderParsingStopsAtBlankLineAndIsCaseInsensitive() {
        let h = headers(["HOST: 127.0.0.1:43917", "", "Origin: https://body-not-a-header.example"])
        XCTAssertEqual(h["host"], "127.0.0.1:43917")
        XCTAssertNil(h["origin"])
    }

    func testHelloCarriesTheCapturedFlagSoTheAppRefreshesNow() {
        var seen: [(String?, Bool)] = []
        let server = PairingServer(payloadProvider: { nil }, onHello: { uid, captured in seen.append((uid, captured)) })
        _ = server.response(for: "GET /thread/hello?userId=u_1&captured=1 HTTP/1.1")
        _ = server.response(for: "GET /thread/hello?userId=u_1 HTTP/1.1")
        XCTAssertEqual(seen.map(\.0), ["u_1", "u_1"])
        XCTAssertEqual(seen.map(\.1), [true, false])
    }
}
