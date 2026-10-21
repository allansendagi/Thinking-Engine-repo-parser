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

    /// Which of the three screens to show. Normally derived from the account's state; a preview or
    /// a snapshot test can force one.
    enum Mode { case ready, signedOut, settingUp }
    var forcedMode: Mode? = nil

    /// An explicit sign-out, not a first launch -- `CredentialStore.clear()` sets this and any
    /// successful pair / sign-in clears it again.
    private var signedOut: Bool { CredentialStore.deliberatelySignedOut }

    private var mode: Mode {
        if let forcedMode { return forcedMode }
        if appState.isPaired { return .ready }
        return signedOut ? .signedOut : .settingUp
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            switch mode {
            case .ready:
                ready
                quietSignIn
            case .signedOut:
                signInPrompt
            case .settingUp:
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
        VStack(alignment: .leading, spacing: 16) {
            header("Signed out", "Sign in with your email to pick your thinking back up.")

            EmailCodeForm(
                title: "Sign in to your Thread account",
                sendCode: { await appState.sendSignInCode(email: $0) },
                verify: { await appState.signIn(email: $0, code: $1) },
                prefillEmail: CredentialStore.lastKnownEmail ?? ""
            )

            Divider()

            Button(startingFresh ? "Starting…" : "Start a New Account Instead") {
                startingFresh = true
                Task { await appState.pairNewAccount(); startingFresh = false }
            }
            .buttonStyle(.link)
            .disabled(startingFresh)
        }
    }

    // MARK: paired -- the quiet "another Mac?" sign-in toggle

    @ViewBuilder
    private var quietSignIn: some View {
        Divider()
        if showSignIn {
            EmailCodeForm(
                title: "Sign in to your Thread account",
                sendCode: { await appState.sendSignInCode(email: $0) },
                verify: { await appState.signIn(email: $0, code: $1) },
                prefillEmail: CredentialStore.lastKnownEmail ?? ""
            )
        } else {
            Button("Already use Thread on another Mac? Sign in") {
                withAnimation(.easeOut(duration: 0.15)) { showSignIn = true }
            }
            .buttonStyle(.link)
        }
    }

    // MARK: paired -- native-first, nothing to do

    @ViewBuilder
    private var ready: some View {
        if AppState.browserCapturePublic {
            VStack(alignment: .leading, spacing: 16) {
                header(
                    "Thread is ready",
                    appState.cursorBackfillAvailable
                        ? "It captures your thinking in Cursor on its own. Connect your browser to add ChatGPT, Claude and Gemini."
                        : "Connect your browser and Thread captures your thinking in ChatGPT, Claude and Gemini as you go."
                )
                actions(primary: "Connect Browser", { appState.connectBrowser() }, secondary: "Not Now", { appState.dismissWelcome() })
            }
        } else {
            VStack(alignment: .leading, spacing: 16) {
                header(
                    "Start with what you've already thought",
                    "Bring in your past Cursor, ChatGPT and Claude conversations. Thread rebuilds the ideas in them — so recall works from the first minute, not the first month."
                )
                Text("Press \(RecallShortcut.current.symbol) anywhere to recall what you've thought about, from any app.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                actions(primary: "Recover My Thinking", { appState.startRecovery() }, secondary: "Skip for Now", { appState.dismissWelcome() })
            }
        }
    }

    private func header(_ title: String, _ message: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.title3.weight(.semibold))
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// The standard pair: the dismissing choice, then the default action on the right (Return
    /// triggers it, Escape the other).
    private func actions(primary: String, _ primaryAction: @escaping () -> Void, secondary: String, _ secondaryAction: @escaping () -> Void) -> some View {
        HStack {
            Spacer()
            Button(secondary, action: secondaryAction)
                .keyboardShortcut(.cancelAction)
            Button(primary, action: primaryAction)
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
        }
        .controlSize(.large)
    }

    // Genuine offline first launch: the account create hasn't landed. Say so honestly and give a
    // visible retry -- `onAppear` fires only once, so it can't be the only path back.
    private var settingUp: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text("Setting up Thread…").font(.title3.weight(.semibold))
                    if retrying { ProgressView().controlSize(.small) }
                }
                Text("This needs a connection the first time. It'll finish on its own once you're online.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button(retrying ? "Trying…" : "Try Again") {
                retrying = true
                Task { await appState.pairNewAccount(); retrying = false }
            }
            .disabled(retrying)
        }
    }
}
