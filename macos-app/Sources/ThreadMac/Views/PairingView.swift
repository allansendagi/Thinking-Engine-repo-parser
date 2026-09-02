import SwiftUI

struct PairingView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Set up Thread").font(.headline)

            EmailCodeForm(
                title: "Sign in with your email",
                sendCode: { await appState.sendSignInCode(email: $0) },
                verify: { await appState.signIn(email: $0, code: $1) }
            )

            Divider()

            VStack(alignment: .leading, spacing: 4) {
                Text("Or start fresh").font(.caption).foregroundColor(.secondary)
                Button("Create a new account") { Task { await appState.pairNewAccount() } }
                Text("Captures right away. Add an email later from Settings to link this account to the website.")
                    .font(.caption2).foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(16)
        .frame(width: 320)
    }
}
