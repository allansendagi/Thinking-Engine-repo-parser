import AppKit
import UniformTypeIdentifiers

extension Notification.Name {
    /// Ask the panel to open the "Add a conversation" (paste) sheet -- from empty states.
    static let threadOpenPaste = Notification.Name("thread.openPaste")
}

/// The first-run path to a full graph. A new user's panel is empty until Thread has something to
/// remember, so the welcome screen and every empty state lead to the same place: bring in the
/// thinking you've already done (Cursor history in one tap, a ChatGPT/Claude export by file
/// picker, drag-and-drop, or the Downloads watcher), then recall works from the first minute.
extension AppState {
    /// "Recover my thinking" -- open the recovery sheet without retiring the welcome's offer.
    func startRecovery() {
        welcomeDismissed = true
        UserDefaults.standard.set(true, forKey: "thread.welcomeDismissed")
        backfillHidden = false
        if case .idle = backfill { backfill = .offered([]) }
        NotificationCenter.default.post(name: .threadPresentPanel, object: nil)
    }

    /// "Choose export file…" -- pick a ChatGPT/Claude export from anywhere. Using the open panel
    /// also sidesteps the Downloads folder permission prompt entirely.
    func chooseExportFile() {
        let panel = NSOpenPanel()
        panel.title = "Choose your ChatGPT or Claude export"
        panel.message = "Pick the .zip the provider emailed you, or the conversations.json inside it."
        panel.allowedContentTypes = [.zip, .json]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        NSApp.activate(ignoringOtherApps: true)
        panel.level = .modalPanel
        guard panel.runModal() == .OK, let url = panel.url else { return }
        importExportFile(url)
    }

    /// A file chosen or dropped: recover from it if it's an export, else say plainly what's wrong.
    func importExportFile(_ url: URL) {
        let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
            .contentModificationDate ?? Date()
        backfillHidden = false
        if let export = Backfill.inspect(url, modified: modified) {
            runBackfill(export)
        } else {
            backfill = .failed(
                "\(url.lastPathComponent) isn't a ChatGPT or Claude export. Use the .zip the provider "
                + "emailed you (or the conversations.json inside it)."
            )
        }
    }
}
