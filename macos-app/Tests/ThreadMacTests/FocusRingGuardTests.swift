import XCTest

/// A list or panel that takes keyboard focus (for arrow keys) must not draw the system focus ring:
/// inside the menu-bar panel it shows as a blue line under the tabs and above the footer. Scans the
/// sources, since an offscreen test window never becomes key and can't show the ring.
final class FocusRingGuardTests: XCTestCase {
    func testEveryFocusableViewHidesTheFocusRing() throws {
        let views = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../Sources/ThreadMac/Views").standardized
        let files = try FileManager.default.contentsOfDirectory(at: views, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
        var offenders: [String] = []
        for file in files {
            let lines = try String(contentsOf: file, encoding: .utf8).components(separatedBy: "\n")
            for (i, line) in lines.enumerated() where line.contains(".focusable()") {
                let next = lines[i..<min(lines.count, i + 6)].joined()
                if !next.contains(".focusEffectDisabled()") { offenders.append("\(file.lastPathComponent):\(i + 1)") }
            }
        }
        XCTAssertEqual(offenders, [], "add .focusEffectDisabled() after .focusable()")
    }
}
