import SwiftUI

/// Shown when this Mac had an account but the credential is gone or was rejected. The cached
/// ideas stay listed (read-only) so this never reads as data loss, and recovery is one action:
/// if we know the account's email it's a single "send me a code" tap, otherwise it's the same
/// passwordless email + code form used to sign in anywhere.
struct ReconnectView: View {
    @EnvironmentObject var appState: AppState

    @State private var codeStep = false
    @State private var code = ""
    @State private var confirmingStartFresh = false

    private var info: AppState.ReconnectInfo {
        appState.reconnect ?? .init(knownEmail: nil, cachedIdeaCount: 0, cachedTitles: [], mismatch: false)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(info.mismatch ? "That's a different account" : "Reconnect to sync")
                    .font(.headline)
                Text(explainer)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if info.cachedIdeaCount > 0 {
                VStack(alignment: .leading, spacing: 5) {
                    Text("\(info.cachedIdeaCount) idea\(info.cachedIdeaCount == 1 ? "" : "s") cached on this Mac")
                        .font(.caption).fontWeight(.medium).foregroundColor(.secondary)
                    ForEach(info.cachedTitles, id: \.self) { title in
                        Text("· \(title)")
                            .font(.caption).foregroundColor(.secondary).lineLimit(1)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
            }

            if let email = info.knownEmail, !info.mismatch {
                knownEmailFlow(email)
            } else {
                EmailCodeForm(
                    title: info.mismatch ? "Sign in with the email on that account" : "Sign in to reconnect",
                    sendCode: { await appState.sendSignInCode(email: $0) },
                    verify: { await appState.signIn(email: $0, code: $1) }
                )
            }

            if let e = appState.authError {
                Text(e).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }

            Divider()

            Button("Start fresh instead") { confirmingStartFresh = true }
                .controlSize(.small)
                .foregroundColor(.secondary)
        }
        .padding(16)
        .frame(width: 320)
        .confirmationDialog(
            "Start a new, empty account?",
            isPresented: $confirmingStartFresh,
            titleVisibility: .visible
        ) {
            Button("Start Fresh", role: .destructive) { Task { await appState.startFresh() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(info.cachedIdeaCount > 0
                 ? "This Mac starts a new, empty account. Your \(info.cachedIdeaCount) cached idea\(info.cachedIdeaCount == 1 ? "" : "s") stay on disk — signing in to the old account later brings them back."
                 : "You can add an email to the new account later.")
        }
    }

    // MARK: - the one-tap flow when we already know who this is

    @ViewBuilder
    private func knownEmailFlow(_ email: String) -> some View {
        if !codeStep {
            Button(appState.authBusy ? "Sending…" : "Send a code to \(maskedEmail(email))") {
                Task { if await appState.sendSignInCode(email: email) { codeStep = true } }
            }
            .buttonStyle(.borderedProminent)
            .disabled(appState.authBusy)

            Button("Use a different email") { appState.useAnotherEmailForReconnect() }
                .controlSize(.small)
        } else {
            Text("Code sent to \(maskedEmail(email))").font(.caption).foregroundColor(.secondary)
            TextField("123456", text: $code)
                .textFieldStyle(.roundedBorder)
                .onChange(of: code) { code = String(code.filter(\.isNumber).prefix(6)) }
            HStack {
                Button(appState.authBusy ? "Reconnecting…" : "Reconnect") {
                    Task { _ = await appState.signIn(email: email, code: code) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(appState.authBusy || code.count != 6)
                Button("Back") { codeStep = false; code = ""; appState.authError = nil }
                    .controlSize(.small)
            }
        }
    }

    private var explainer: String {
        if info.mismatch {
            return "The account you just signed into has no ideas in it. The \(info.cachedIdeaCount) cached here belong to a different account — sign in with the email attached to that one, or start fresh."
        }
        return "Your session ended. Your ideas are safe on Thread — sign in to bring this Mac back in sync."
    }
}

/// `allan@gmail.com` -> `a•••n@gmail.com`. Enough to recognise, not enough to leak.
private func maskedEmail(_ email: String) -> String {
    guard let at = email.firstIndex(of: "@") else { return email }
    let name = email[email.startIndex..<at]
    let host = email[at...]
    guard name.count > 2 else { return "\(name.prefix(1))•••\(host)" }
    return "\(name.prefix(1))•••\(name.suffix(1))\(host)"
}
