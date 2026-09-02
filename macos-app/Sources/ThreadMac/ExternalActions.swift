import AppKit

extension Notification.Name {
    /// Ask the floating quick-recall panel to present itself. `AppDelegate` owns the panel;
    /// SwiftUI, the `thread://` URL handler and the Services menu all post this to bring it up.
    static let threadPresentPanel = Notification.Name("thread.presentPanel")
}

/// One vocabulary for every "drive Thread from outside its own UI" surface: the `thread://` URL
/// scheme, the Services menu, and the App Intents layer (Shortcuts / Spotlight / Siri). All
/// three route through `AppState.perform(_:)`, so it stays the single source of truth and the
/// intents are a thin shell over it.
enum ThreadAction: Equatable {
    /// Open the panel and run a search for this text — the same path as typing in the field.
    case recall(String)
    /// Open the panel on this idea's detail.
    case openIdea(String)
    /// Open the panel on the Open loops tab.
    case openLoops
    /// Build + copy the continuation packet for this idea (opens the panel on its detail).
    case continueIdea(String)
    /// Resolve a free-text topic to its best-matching idea, then continue it. For voice/Shortcuts,
    /// where the caller names a topic rather than an id.
    case continueTopic(String)

    /// Parse a `thread://` URL. Returns nil for anything unrecognised.
    ///
    ///   thread://recall?q=<text>        thread://recall/<text>
    ///   thread://idea/<id>              thread://idea?id=<id>
    ///   thread://loops
    ///   thread://continue?idea=<id>     thread://continue/<id>
    ///   thread://continue?topic=<text>
    static func parse(_ url: URL) -> ThreadAction? {
        guard url.scheme?.lowercased() == "thread" else { return nil }
        let host = (url.host ?? "").lowercased()
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let path = url.pathComponents.filter { $0 != "/" }

        func query(_ names: String...) -> String? {
            for n in names {
                if let v = comps?.queryItems?.first(where: { $0.name == n })?.value {
                    let t = v.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !t.isEmpty { return t }
                }
            }
            return nil
        }
        func firstPath() -> String? {
            guard let raw = path.first else { return nil }
            let decoded = (raw.removingPercentEncoding ?? raw)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return decoded.isEmpty ? nil : decoded
        }

        switch host {
        case "recall", "search":
            guard let text = query("q", "query", "text") ?? firstPath() else { return nil }
            return .recall(text)
        case "idea", "open":
            guard let id = query("id") ?? firstPath() else { return nil }
            return .openIdea(id)
        case "loops", "open-loops":
            return .openLoops
        case "continue":
            if let topic = query("topic") { return .continueTopic(topic) }
            guard let id = query("idea", "id") ?? firstPath() else { return nil }
            return .continueIdea(id)
        default:
            return nil
        }
    }
}
