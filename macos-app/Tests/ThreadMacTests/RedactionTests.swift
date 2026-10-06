import XCTest
@testable import ThreadMac

/// Same vectors as src/capture/redact.test.ts -- the Mac and the browser must agree.
final class RedactionTests: XCTestCase {
    let vectors: [(String, String)] = [
        ("my key is sk-proj-abcdefghijklmnopqrstuvwx123", "my key is [redacted api key]"),
        ("export ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA", "export ANTHROPIC_API_KEY=[redacted api key]"),
        ("aws AKIAIOSFODNN7EXAMPLE done", "aws [redacted aws key] done"),
        ("token ghp_" + String(repeating: "a", count: 36), "token [redacted github token]"),
        ("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123", "Authorization: Bearer [redacted bearer token]"),
        (#"password = "hunter2hunter2""#, #"password = "[redacted secret]""#),
        ("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----", "[redacted private key]"),
        ("We should charge per seat, not a flat fee.", "We should charge per seat, not a flat fee."),
        ("the password reset flow needs a second step", "the password reset flow needs a second step"),
        ("const task = await sk(request)", "const task = await sk(request)"),
    ]

    func testSharedVectors() {
        for (input, expected) in vectors {
            XCTAssertEqual(Redaction.redact(input), expected, input)
        }
    }

    func testIdempotent() {
        for (input, _) in vectors {
            let once = Redaction.redact(input)
            XCTAssertEqual(Redaction.redact(once), once)
        }
    }

    func testWalksExportJSON() {
        let out = Redaction.redactDeep(["mapping": ["a": ["parts": ["key sk-abcdefghijklmnopqrstuvwxyz"]]], "n": 3] as [String: Any]) as! [String: Any]
        let parts = ((out["mapping"] as! [String: Any])["a"] as! [String: Any])["parts"] as! [String]
        XCTAssertEqual(parts, ["key [redacted api key]"])
        XCTAssertEqual(out["n"] as? Int, 3)
    }
}
