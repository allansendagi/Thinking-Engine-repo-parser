import Foundation

/// The hand-off between the Share extension and the app. The extension is sandboxed and short-lived,
/// so it only drops a small file into a shared "inbox" folder; the app, which is normally running,
/// picks the files up and captures them. If the app isn't running, they wait and are captured at the
/// next launch. Foundation-only: the extension compiles this very file (see build-share.sh).
struct SharedItem: Codable, Equatable {
    var id: String
    var text: String
    var createdAt: Date
    /// The app it was shared from, when the system says (informational).
    var from: String?
}

enum ShareInbox {
    /// Test seam: when set, the inbox lives here instead of the shared group container.
    static var directoryOverride: URL?

    /// Fewest words worth capturing from a share (a stray word isn't a thought).
    static let minimumWords = 3

    static var directory: URL? {
        let base = directoryOverride ?? FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: WidgetStore.group)
        return base?.appendingPathComponent("inbox", isDirectory: true)
    }

    static func wordCount(_ text: String) -> Int { text.split(whereSeparator: { $0.isWhitespace }).count }

    /// Called by the extension. False when the folder isn't reachable or the text is too short.
    @discardableResult
    static func write(text raw: String, from: String? = nil, now: Date = Date()) -> Bool {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard wordCount(text) >= minimumWords, let dir = directory else { return false }
        let item = SharedItem(id: UUID().uuidString, text: text, createdAt: now, from: from)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(item) else { return false }
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try data.write(to: dir.appendingPathComponent("\(item.id).json"), options: .atomic)
            return true
        } catch { return false }
    }

    /// Everything waiting, oldest first. Anything that isn't a valid item is ignored (and left alone).
    static func pending() -> [(url: URL, item: SharedItem)] {
        guard let dir = directory,
              let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return files
            .filter { $0.pathExtension == "json" }
            .compactMap { url in (try? Data(contentsOf: url)).flatMap { try? decoder.decode(SharedItem.self, from: $0) }.map { (url, $0) } }
            .sorted { $0.item.createdAt < $1.item.createdAt }
    }

    /// Called by the app. Hands each waiting item to `capture`; an item is removed only when `capture`
    /// takes it (so shares made before sign-in wait instead of being lost). Returns how many were taken.
    @discardableResult
    static func drain(capture: (String) -> Bool) -> Int {
        var taken = 0
        for (url, item) in pending() where capture(item.text) {
            try? FileManager.default.removeItem(at: url)
            taken += 1
        }
        return taken
    }
}
