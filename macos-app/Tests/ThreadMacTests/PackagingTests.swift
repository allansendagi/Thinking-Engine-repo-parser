import Foundation
import XCTest

/// The signed app is launched by a stricter parser than `plutil -lint`. A double hyphen inside an
/// XML comment passes plutil but makes macOS reject the entitlements ("AMFIUnserializeXML: syntax
/// error"), which blocks the whole app from running. So parse the file strictly here.
final class PackagingTests: XCTestCase {
    private var macosApp: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    func testEntitlementsAreStrictlyValidXML() throws {
        let data = try Data(contentsOf: macosApp.appendingPathComponent("Thread.entitlements"))
        let parser = XMLParser(data: data)
        XCTAssertTrue(parser.parse(), "Thread.entitlements isn't valid XML: \(parser.parserError?.localizedDescription ?? "?") (line \(parser.lineNumber))")
    }

    func testEntitlementsAreExactlyWhatTheAppNeeds() throws {
        let data = try Data(contentsOf: macosApp.appendingPathComponent("Thread.entitlements"))
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        XCTAssertEqual(Set(plist.keys), [
            "com.apple.security.network.client",
            "com.apple.security.network.server",
            "com.apple.security.device.audio-input",
        ])
    }
}
