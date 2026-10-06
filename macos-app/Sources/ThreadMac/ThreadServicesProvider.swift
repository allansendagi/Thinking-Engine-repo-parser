import AppKit
import UserNotifications

/// Backs the "Recall in Thread" and "Capture in Thread" entries in the system Services menu (declared under `NSServices`
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

    /// `NSMessage` = `captureInThread`. Select a conversation in ANY app -- the ChatGPT or Claude
    /// desktop apps (whose history isn't readable on disk), an iPad AI app running on the Mac, a
    /// PDF, a note -- then Services ▸ Capture in Thread (or its keyboard shortcut, assignable in
    /// System Settings ▸ Keyboard ▸ Shortcuts ▸ Services). Same local-first path as Paste: it
    /// lands instantly and syncs in the background, and the extractor works out who said what.
    @objc func captureInThread(
        _ pboard: NSPasteboard,
        userData: String?,
        error: AutoreleasingUnsafeMutablePointer<NSString>?
    ) {
        let text = (pboard.string(forType: .string) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 20 else {
            error?.pointee = "Select a bit more of the conversation to capture." as NSString
            return
        }
        MainActor.assumeIsolated {
            _ = appState.capture(text)
        }
        let content = UNMutableNotificationContent()
        content.title = "Captured in Thread"
        content.body = "\(text.count.formatted()) characters — your ideas will appear in a moment."
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "thread.capture.\(UUID().uuidString)", content: content, trigger: nil)
        )
    }
}
