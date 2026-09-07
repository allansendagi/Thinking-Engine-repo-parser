import SwiftUI

/// First run. Thread has already created the account, so there is nothing to set up. Native-first
/// (`browserCapturePublic == false`): the screen names the two capture paths that work with no
/// browser -- Cursor's local store (automatic) and paste-a-conversation for ChatGPT/Claude -- and
/// gets out of the way. Once browser capture is a public, one-click thing, `ready` gains the
/// "Connect Browser" action. Signing in to an existing account (another Mac) stays a quiet
/// afterthought either way.
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

    // The account is up. Native-first: nothing to do -- just start. With browser capture public,
    // the one real action is connecting the browser.
    @ViewBuilder
    private var ready: some View {
        if AppState.browserCapturePublic {
            VStack(alignment: .leading, spacing: 14) {
                header(
                    "Thread is ready",
                    "It captures your thinking in Cursor on its own. Connect your browser to add ChatGPT, Claude and Gemini."
                )
                Button("Connect Browser") { appState.connectBrowser() }
                    .buttonStyle(.borderedProminent).tint(Theme.accent).controlSize(.large)
                Button("Not now") { appState.dismissWelcome() }
                    .buttonStyle(.plain)
                    .font(.system(size: 11)).foregroundStyle(Theme.ink(0.45))
            }
        } else {
            VStack(alignment: .leading, spacing: 14) {
                header(
                    "Thread is ready",
                    "It picks up your thinking in Cursor on its own. For ChatGPT and Claude, paste a conversation in — Thread takes it from there."
                )
                HStack(spacing: 6) {
                    Text("⌘⇧T").font(.system(size: 11, weight: .semibold, design: .rounded))
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Theme.ink(0.06), in: RoundedRectangle(cornerRadius: 5))
                    Text("Recall anything you've thought about").font(.system(size: 11)).foregroundStyle(Theme.ink(0.5))
                }
                Button("Start") { appState.dismissWelcome() }
                    .buttonStyle(.borderedProminent).tint(Theme.accent).controlSize(.large)
            }
        }
    }

    private func header(_ title: String, _ body: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 15, weight: .semibold))
            Text(body).font(.system(size: 12)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
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
