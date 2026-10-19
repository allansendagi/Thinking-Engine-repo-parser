import Foundation

/// What the app tells the Thread widget, and how it is stored. Foundation-only on purpose: the widget
/// extension compiles this very file (see build-widget.sh), so the two can never drift apart.
struct WidgetSnapshot: Codable, Equatable {
    struct Idea: Codable, Equatable, Identifiable {
        var id: String
        var title: String
        var source: String?
        var touched: Date?
    }
    var updatedAt: Date
    var ideas: [Idea]
    var openLoops: Int
}

enum WidgetStore {
    /// `<team id>.<bundle id>`: macOS accepts a team-prefixed group id from a signed app without a
    /// provisioning profile (verified on a Developer ID build).
    static let group = "RPU3YJFJK7.com.thread.mac"
    static let fileName = "widget.json"

    /// Test seam: when set, the snapshot lives here instead of the shared group container.
    static var directoryOverride: URL?

    private static var fileURL: URL? {
        let dir = directoryOverride ?? FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
        return dir?.appendingPathComponent(fileName)
    }

    static func load() -> WidgetSnapshot? {
        guard let url = fileURL, let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(WidgetSnapshot.self, from: data)
    }

    @discardableResult
    static func save(_ snapshot: WidgetSnapshot) -> Bool {
        guard let url = fileURL else { return false }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(snapshot) else { return false }
        do { try data.write(to: url, options: .atomic); return true } catch { return false }
    }

    static func clear() {
        if let url = fileURL { try? FileManager.default.removeItem(at: url) }
    }
}
