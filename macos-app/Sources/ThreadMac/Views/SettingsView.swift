import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var urlDraft = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Settings").font(.headline)

            Text("API base URL").font(.caption).foregroundColor(.secondary)
            TextField("http://localhost:8787", text: $urlDraft)
                .textFieldStyle(.roundedBorder)
                .onAppear { urlDraft = appState.apiBaseUrl }

            if let userId = appState.userId {
                Text("Paired as \(userId)").font(.caption).foregroundColor(.secondary)
            }

            HStack {
                Spacer()
                Button("Save") {
                    appState.setApiBaseUrl(urlDraft)
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(16)
        .frame(width: 320)
    }
}
