import SwiftUI

/// Two-step email + 6-digit code form. Used for signing this Mac in to an existing account
/// (WelcomeView / ReconnectView) and for claiming an anonymous account with an email (SettingsView).
struct EmailCodeForm: View {
    @EnvironmentObject var appState: AppState

    let title: String
    /// Sends the code. Return true to advance to the code step.
    let sendCode: (_ email: String) async -> Bool
    /// Verifies the code. Return true on success.
    let verify: (_ email: String, _ code: String) async -> Bool
    var onDone: () -> Void = {}
    /// Filled into the email field on first appearance -- the last-known email, so signing back
    /// in after a sign-out is one tap.
    var prefillEmail: String = ""
    /// When set, the form owns its own Cancel: shown left of the main button in one trailing row
    /// (the macOS layout), with Escape bound to it. Nil keeps the original layout.
    var cancel: (() -> Void)? = nil
    /// Put the cursor in the first field as soon as the form appears.
    var autofocus: Bool = false
    @FocusState private var focused: Bool

    @State private var email = ""
    @State private var code = ""
    @State private var step: Step = .email
    enum Step { case email, code }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !title.isEmpty { Text(title).font(.subheadline.weight(.medium)) }

            if step == .email {
                TextField("you@example.com", text: $email)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.emailAddress)
                    .focused($focused)
                    .onSubmit(sendEmailCode)
                if let cancel {
                    HStack {
                        Spacer()
                        Button("Not Now", action: cancel).keyboardShortcut(.cancelAction)
                        Button(appState.authBusy ? "Sending…" : "Send Code", action: sendEmailCode)
                            .buttonStyle(.borderedProminent)
                            .disabled(!canSend)
                    }
                } else {
                    Button(appState.authBusy ? "Sending…" : "Send Code", action: sendEmailCode)
                        .buttonStyle(.borderedProminent)
                        .disabled(!canSend)
                }
            } else {
                Text("Code sent to \(email)").font(.subheadline).foregroundStyle(.secondary)
                TextField("123456", text: $code)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.oneTimeCode)
                    .focused($focused)
                    .onChange(of: code) { code = String(code.filter(\.isNumber).prefix(6)) }
                    .onSubmit(verifyCode)
                HStack {
                    Button("Back") { step = .email; code = ""; appState.authError = nil }
                    Spacer()
                    if let cancel { Button("Not Now", action: cancel).keyboardShortcut(.cancelAction) }
                    Button(appState.authBusy ? "Verifying…" : "Verify", action: verifyCode)
                        .buttonStyle(.borderedProminent)
                        .disabled(!canVerify)
                }
            }

            if let e = appState.authError {
                Text(e).font(.subheadline).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
        }
        .onAppear {
            if email.isEmpty { email = prefillEmail }
            if autofocus { focused = true }
        }
        // The code field takes the cursor when it appears, so the code can be typed straight in.
        .onChange(of: step) { if autofocus { focused = true } }
    }

    // Return in a field does what the button does, under the same conditions.
    private var canSend: Bool { !appState.authBusy && email.contains("@") }
    private var canVerify: Bool { !appState.authBusy && code.count == 6 }

    private func sendEmailCode() {
        guard canSend else { return }
        Task { if await sendCode(email.trimmingCharacters(in: .whitespaces)) { step = .code } }
    }

    private func verifyCode() {
        guard canVerify else { return }
        Task {
            if await verify(email.trimmingCharacters(in: .whitespaces), code) {
                step = .email; email = ""; code = ""; onDone()
            }
        }
    }
}
