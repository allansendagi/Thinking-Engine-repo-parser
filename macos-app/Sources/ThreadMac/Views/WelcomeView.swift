import SwiftUI

/// First run and post-sign-out. Three states:
///  - genuine first run (`!isPaired`, never signed out): the account is auto-created in `onAppear`,
///    then `ready` -- native-first, nothing to set up.
///  - deliberately signed out (`!isPaired`, `CredentialStore.deliberatelySignedOut`): DON'T
///    auto-create a throwaway account -- sign-in is the screen, with "start a new account" as the
///    secondary. This is the path back to your real account.
///  - offline first run: `settingUp` -- honest wait + a visible retry.
/// Once browser capture is public, `ready` gains the "Connect Browser" action.
struct WelcomeView: View {
    @EnvironmentObject var appState: AppState
    @State private var showSignIn = false
    @State private var retrying = false
    @State private var startingFresh = false

    /// An explicit sign-out, not a first launch -- `CredentialStore.clear()` sets this and any
    /// successful pair / sign-in clears it again.
    private var signedOut: Bool { CredentialStore.deliberatelySignedOut }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if appState.isPaired {
                ready
                quietSignIn
            } else if signedOut {
                signInPrompt
            } else {
                settingUp
            }
        }
        .padding(16)
        .frame(width: 320)
        .onAppear {
            // Only on a true first run. Right after a deliberate sign-out, auto-creating an
            // account would bury the real one behind a fresh empty stranger.
            if !appState.isPaired && !signedOut {
                Task { await appState.pairNewAccount() }
            }
        }
    }

    // MARK: signed out -- sign-in is the primary action

    private var signInPrompt: some View {
        VStack(alignment: .leading, spacing: 14) {
            header("Signed out", "Sign in with your email to pick your thinking back up.")

            EmailCodeForm(
                title: "Sign in to your Thread account",
                sendCode: { await appState.sendSignInCode(email: $0) },
                verify: { await appState.signIn(email: $0, code: $1) }
            )

            Divider().padding(.top, 2)

            Button(startingFresh ? "Starting…" : "Start a new account instead") {
                startingFresh = true
                Task { await appState.pairNewAccount(); startingFresh = false }
            }
            .buttonStyle(.plain)
            .font(.system(size: 11)).foregroundStyle(Theme.ink(0.4))
            .disabled(startingFresh)
        }
    }

    // MARK: paired -- the quiet "another Mac?" sign-in toggle

    @ViewBuilder
    private var quietSignIn: some View {
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

    // MARK: paired -- native-first, nothing to do

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
