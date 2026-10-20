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
            "com.apple.security.application-groups",
        ])
        let groups = try XCTUnwrap(plist["com.apple.security.application-groups"] as? [String])
        XCTAssertEqual(groups, ["RPU3YJFJK7.com.thread.mac"], "must match WidgetStore.group and the widget's entitlement")
    }

    /// The extensions' own plists and entitlements are read by the same strict parsers at signing and
    /// launch, so check them here too.
    func testExtensionPlistsAreStrictlyValidXML() throws {
        for path in ["Widget/Info.plist", "Widget/ThreadWidget.entitlements", "ShareExtension/Info.plist", "ShareExtension/ThreadShare.entitlements"] {
            let data = try Data(contentsOf: macosApp.appendingPathComponent(path))
            let parser = XMLParser(data: data)
            XCTAssertTrue(parser.parse(), "\(path) isn't valid XML: \(parser.parserError?.localizedDescription ?? "?") (line \(parser.lineNumber))")
        }
    }

    func testBothExtensionsShareTheAppsGroupAndAreSandboxed() throws {
        for path in ["Widget/ThreadWidget.entitlements", "ShareExtension/ThreadShare.entitlements"] {
            let data = try Data(contentsOf: macosApp.appendingPathComponent(path))
            let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
            XCTAssertEqual(plist["com.apple.security.app-sandbox"] as? Bool, true, "\(path): extensions must be sandboxed")
            XCTAssertEqual(plist["com.apple.security.application-groups"] as? [String], ["RPU3YJFJK7.com.thread.mac"], path)
        }
    }
}
