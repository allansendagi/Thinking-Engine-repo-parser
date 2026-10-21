import SwiftUI
import XCTest
@testable import ThreadMac

/// Renders screens to PNG so they can be looked at without launching the app. Opt in:
///
///     THREAD_SNAPSHOT_DIR=/tmp/ui swift test --filter UISnapshotTests
///
/// Skipped everywhere else (CI never writes images). Not an assertion about pixels -- a way to see.
@MainActor
final class UISnapshotTests: XCTestCase {
    private var dir: URL {
        get throws {
            guard let path = ProcessInfo.processInfo.environment["THREAD_SNAPSHOT_DIR"] else {
                throw XCTSkip("set THREAD_SNAPSHOT_DIR to write screen snapshots")
            }
            let url = URL(fileURLWithPath: path, isDirectory: true)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            return url
        }
    }

    /// One view on the standard window background, at 2x, light and dark. Drawn through a real
    /// (offscreen) window so native AppKit-backed controls -- checkboxes, buttons -- render as they do
    /// in the app; SwiftUI's ImageRenderer can't draw those.
    @discardableResult
    private func snap<V: View>(_ name: String, width: CGFloat, @ViewBuilder _ content: () -> V) throws -> [URL] {
        var written: [URL] = []
        for scheme in [ColorScheme.light, .dark] {
            let appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)!
            let framed = content()
                .padding(20)
                .frame(width: width)
                .background(Color(nsColor: .windowBackgroundColor))
            let host = NSHostingView(rootView: framed)
            let size = NSSize(width: width, height: host.fittingSize.height)
            let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
            window.appearance = appearance
            window.contentView = host
            host.frame = NSRect(origin: .zero, size: size)
            host.layoutSubtreeIfNeeded()
            let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: rep)
            let png = rep.representation(using: .png, properties: [:])
            let url = try dir.appendingPathComponent("\(name)-\(scheme == .dark ? "dark" : "light").png")
            XCTAssertNotNil(png, "could not render \(name)")
            try png?.write(to: url)
            written.append(url)
        }
        return written
    }

    func testWelcomeSettingUp() throws {
        try snap("welcome-setting-up", width: 360) { WelcomeView().environmentObject(AppState()) }
    }

    func testQuestionList() throws {
        let loops = [
            OpenLoop(id: "1", statement: "Do guest collaborators count toward the bill?", createdAt: "2026-10-20T10:00:00Z", resolved: true,
                     answeredBy: "Five free guests per account, then they are billed like members."),
            OpenLoop(id: "2", statement: "Should we offer a yearly discount?", createdAt: "2026-10-20T10:05:00Z", resolved: false),
            OpenLoop(id: "3", statement: "Is a SOC 2 report a must-have ahead of landing enterprise customer number one?", createdAt: "2026-10-20T10:09:00Z", resolved: true),
        ]
        try snap("question-list", width: 380) { QuestionList(loops: loops) { _ in } }
    }
}
