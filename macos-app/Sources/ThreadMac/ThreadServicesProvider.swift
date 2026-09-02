import AppKit

/// Backs the "Recall in Thread" entry in the system Services menu (declared under `NSServices`
/// in the bundle's Info.plist). Select text in any app → Services ▸ Recall in Thread → the
/// quick-recall panel opens with that text as the query. AppKit delivers service requests on
/// the main thread.
final class ThreadServicesProvider: NSObject {
    private let appState: AppState

    init(appState: AppState) {
        self.appState = appState
        super.init()
    }

    /// `NSMessage` = `recallInThread` in Info.plist. The selector name (sans the `:userData:error:`
    /// suffix AppKit appends) must match exactly.
    @objc func recallInThread(
        _ pboard: NSPasteboard,
        userData: String?,
        error: AutoreleasingUnsafeMutablePointer<NSString>?
    ) {
        let text = (pboard.string(forType: .string) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            error?.pointee = "No text to recall." as NSString
            return
        }
        // Keep the query to a sentence or so — a whole selected essay isn't a useful search.
        let query = text.count > 240 ? String(text.prefix(240)) : text
        MainActor.assumeIsolated {
            appState.perform(.recall(query))
        }
    }
}
