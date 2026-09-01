import SwiftUI

struct PairingView: View {
    @EnvironmentObject var appState: AppState
    @State private var existingUserId = ""
    @State private var existingToken = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Not paired with a Thread account yet.")
                .font(.callout)
            Button("Create a new account") { Task { await appState.pairNewAccount() } }
                .buttonStyle(.borderedProminent)

            Divider()

            Text("Or use an existing account").font(.caption).foregroundColor(.secondary)
            TextField("User ID", text: $existingUserId).textFieldStyle(.roundedBorder)
            SecureField("Token", text: $existingToken).textFieldStyle(.roundedBorder)
            Button("Use these credentials") {
                appState.useExistingCredentials(userId: existingUserId, token: existingToken)
            }
            .disabled(existingUserId.isEmpty || existingToken.isEmpty)
        }
        .padding(14)
    }
}
