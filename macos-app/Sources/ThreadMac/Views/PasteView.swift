import SwiftUI

/// Native, browser-free capture: paste a conversation's text (copied from ChatGPT, Claude,
/// anywhere) directly, bypassing the browser extension's DOM-scraping entirely.
struct PasteView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Add a conversation").font(.headline)
            Text("Paste text copied from ChatGPT, Claude, or anywhere else you've been thinking.")
                .font(.caption)
                .foregroundColor(.secondary)

            TextEditor(text: $text)
                .font(.system(.body, design: .monospaced))
                .frame(minHeight: 220)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.gray.opacity(0.3)))

            if let status = appState.pasteStatus {
                Text(status).font(.caption).foregroundColor(.green)
            }
            if let error = appState.errorMessage {
                Text(error).font(.caption).foregroundColor(.red)
            }

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button(appState.isPasting ? "Adding…" : "Add to Thread") {
                    Task {
                        let ok = await appState.submitPaste(text)
                        if ok { text = "" }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(appState.isPasting || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(16)
        .frame(width: 420, height: 380)
        .onDisappear { appState.pasteStatus = nil }
    }
}
