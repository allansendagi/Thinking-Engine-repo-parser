import XCTest

/// A guard against VoiceOver regressions. SwiftUI only builds its accessibility tree when a screen
/// reader is running, so a unit test can't read it; this checks the source for the two mistakes
/// that make a control unusable by VoiceOver:
///   1. a tap gesture with no accessibility action (VoiceOver can't activate a bare gesture), and
///   2. an icon-only button with no spoken label (VoiceOver says just "button").
/// It is a heuristic, not proof: the ⌘F5 pass on a real Mac is still the real test.
final class AccessibilityGuardTests: XCTestCase {
    private func sourceFiles() throws -> [(name: String, lines: [String])] {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/ThreadMac")
        let enumerator = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
        var out: [(String, [String])] = []
        for case let url as URL in enumerator where url.pathExtension == "swift" {
            let text = try String(contentsOf: url, encoding: .utf8)
            out.append((url.lastPathComponent, text.components(separatedBy: "\n")))
        }
        XCTAssertFalse(out.isEmpty, "found no sources to check")
        return out
    }

    /// The lines from `i` to the end of the statement's modifier chain (a generous window).
    private func window(_ lines: [String], from i: Int, _ n: Int) -> String {
        lines[i..<min(lines.count, i + n)].joined(separator: "\n")
    }

    func testEveryTapGestureCanBeActivatedWithVoiceOver() throws {
        var problems: [String] = []
        for (name, lines) in try sourceFiles() {
            for (i, line) in lines.enumerated() where line.contains(".onTapGesture") {
                let w = window(lines, from: i, 9)
                if !(w.contains(".accessibilityAction") || w.contains("rowAccessibility")) {
                    problems.append("\(name):\(i + 1) .onTapGesture has no .accessibilityAction")
                }
            }
        }
        XCTAssertEqual(problems, [], "VoiceOver can't activate these:\n" + problems.joined(separator: "\n"))
    }

    func testIconOnlyButtonsHaveSpokenLabels() throws {
        var problems: [String] = []
        for (name, lines) in try sourceFiles() {
            for (i, line) in lines.enumerated() {
                // A button/menu label that is just an icon.
                guard line.contains("label: {") || line.contains("} label: {") else { continue }
                let label = window(lines, from: i, 7)
                let iconOnly = (label.contains("Image(systemName:") || label.contains("Glyph(kind:"))
                    && !label.contains("Text(") && !label.contains("Label(")
                guard iconOnly else { continue }
                // HeaderButton takes its spoken name as a parameter on the same call.
                let before = window(lines, from: max(0, i - 8), 9)
                if before.contains("accessibilityName:") { continue }
                let after = window(lines, from: i, 12)
                if !after.contains(".accessibilityLabel") {
                    problems.append("\(name):\(i + 1) icon-only control has no .accessibilityLabel")
                }
            }
        }
        XCTAssertEqual(problems, [], "VoiceOver would say only \"button\" for:\n" + problems.joined(separator: "\n"))
    }
}
