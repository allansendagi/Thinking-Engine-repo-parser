import SwiftUI

/// First run. Thread has already created the account and can already capture from native Mac
/// apps -- so there are no decisions here. The one real setup action for a browser user is
/// connecting the browser; that's the only primary control. Signing in to an existing account
/// (another Mac) is a quiet afterthought, not a fork in the road.
struct WelcomeView: View {
    @EnvironmentObject var appState: AppState
    @State private var showSignIn = false
    @State private var retrying = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if appState.isPaired {
                ready
            } else {
                settingUp
            }

            Divider().padding(.top, 2)

            if showSignIn {
                EmailCodeForm(
                    title: "Sign in to your Thread account",
                    sendCode: { await appState.sendSignInCode(email: $0) },
                    verify: { await appState.signIn(email: $0, code: $1) }
                )
            } else {
                Button("Already use Thread on another Mac? Sign in") {
                    withAnimation(.easeOut(duration: 0.15)) { showSignIn = true }
                }
                .buttonStyle(.plain)
                .font(.system(size: 11)).foregroundStyle(Theme.ink(0.4))
            }
        }
        .padding(16)
        .frame(width: 320)
        .onAppear { if !appState.isPaired { Task { await appState.pairNewAccount() } } }
    }

    // The account is up: the one real action is connecting a browser.
    private var ready: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Thread is ready")
                    .font(.system(size: 15, weight: .semibold))
                Text("Connect your browser to let Thread capture the AI conversations you have there.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button("Connect Browser") { appState.connectBrowser() }
                .buttonStyle(.borderedProminent).tint(Theme.accent).controlSize(.large)
            Button("You can start with supported Mac apps without this") {
                appState.dismissWelcome()
            }
            .buttonStyle(.plain)
            .font(.system(size: 11)).foregroundStyle(Theme.ink(0.45))
        }
    }

    // Genuine offline first launch: the account create hasn't landed. Say so honestly and give a
    // visible retry -- `onAppear` fires only once, so it can't be the only path back.
    private var settingUp: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Setting up Thread…")
                .font(.system(size: 15, weight: .semibold))
            Text("This needs a connection the first time. It'll finish on its own once you're online.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(retrying ? "Trying…" : "Try again") {
                retrying = true
                Task { await appState.pairNewAccount(); retrying = false }
            }
            .controlSize(.small)
            .disabled(retrying)
        }
    }
}
