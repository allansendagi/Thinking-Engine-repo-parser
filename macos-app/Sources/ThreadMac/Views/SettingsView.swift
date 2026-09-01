import AppKit
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var urlDraft = ""
    @State private var copied = false
    @State private var showAdvanced = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Settings").font(.headline)

            VStack(alignment: .leading, spacing: 6) {
                Label("Browser extension", systemImage: "puzzlepiece.extension")
                    .font(.subheadline).fontWeight(.medium)
                Text("While Thread is running, the extension connects automatically. If it can't, paste this pairing string into the extension popup.")
                    .font(.caption).foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                if let pairing = appState.pairingString {
                    HStack {
                        Text(pairing)
                            .font(.system(.caption, design: .monospaced))
                            .lineLimit(1).truncationMode(.middle)
                            .textSelection(.enabled)
                            .padding(6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.gray.opacity(0.1))
                            .cornerRadius(5)
                        Button(copied ? "Copied" : "Copy") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(pairing, forType: .string)
                            copied = true
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                        }
                    }
                } else {
                    Text("Not paired yet.").font(.caption).foregroundColor(.secondary)
                }
            }

            Divider()

            DisclosureGroup("Advanced", isExpanded: $showAdvanced) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("API base URL").font(.caption).foregroundColor(.secondary)
                    TextField("https://…", text: $urlDraft)
                        .textFieldStyle(.roundedBorder)
                        .onAppear { urlDraft = appState.apiBaseUrl }
                    if let userId = appState.userId {
                        Text("Account: \(userId)").font(.caption2).foregroundColor(.secondary)
                            .textSelection(.enabled)
                    }
                    Button("Unpair this Mac", role: .destructive) {
                        appState.unpair()
                        dismiss()
                    }
                    .font(.caption)
                }
                .padding(.top, 4)
            }
            .font(.caption)

            HStack {
                Spacer()
                Button("Done") {
                    if urlDraft != appState.apiBaseUrl { appState.setApiBaseUrl(urlDraft) }
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(16)
        .frame(width: 340)
    }
}
