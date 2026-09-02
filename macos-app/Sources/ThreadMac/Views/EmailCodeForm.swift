import SwiftUI

/// Two-step email + 6-digit code form. Used for signing this Mac in to an existing account
/// (PairingView) and for claiming an anonymous account with an email (SettingsView).
struct EmailCodeForm: View {
    @EnvironmentObject var appState: AppState

    let title: String
    /// Sends the code. Return true to advance to the code step.
    let sendCode: (_ email: String) async -> Bool
    /// Verifies the code. Return true on success.
    let verify: (_ email: String, _ code: String) async -> Bool
    var onDone: () -> Void = {}

    @State private var email = ""
    @State private var code = ""
    @State private var step: Step = .email
    enum Step { case email, code }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.subheadline).fontWeight(.medium)

            if step == .email {
                TextField("you@example.com", text: $email)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.emailAddress)
                Button(appState.authBusy ? "Sending…" : "Send code") {
                    Task { if await sendCode(email.trimmingCharacters(in: .whitespaces)) { step = .code } }
                }
                .buttonStyle(.borderedProminent)
                .disabled(appState.authBusy || !email.contains("@"))
            } else {
                Text("Code sent to \(email)").font(.caption).foregroundColor(.secondary)
                TextField("123456", text: $code)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: code) { code = String(code.filter(\.isNumber).prefix(6)) }
                HStack {
                    Button(appState.authBusy ? "Verifying…" : "Verify") {
                        Task {
                            if await verify(email.trimmingCharacters(in: .whitespaces), code) {
                                step = .email; email = ""; code = ""; onDone()
                            }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(appState.authBusy || code.count != 6)
                    Button("Back") { step = .email; code = ""; appState.authError = nil }
                        .controlSize(.small)
                }
            }

            if let e = appState.authError {
                Text(e).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
