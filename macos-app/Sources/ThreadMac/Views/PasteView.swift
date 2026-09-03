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

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Add to Thread") {
                    // Optimistic: captured the moment you click. The panel shows it right away
                    // with an on-device draft, then it syncs in the background.
                    appState.capture(text)
                    text = ""
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(16)
        .frame(width: 420, height: 380)
    }
}
