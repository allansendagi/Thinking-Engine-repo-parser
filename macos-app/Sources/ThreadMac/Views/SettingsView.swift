import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct SettingsView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var urlDraft = ""
    @State private var copied = false
    @State private var showAdvanced = false
    @State private var confirmStrandedUnpair = false
    /// On an anonymous account: switch the email form from "attach to this account" to "sign in to
    /// a different one". The way back when this Mac is on the wrong (e.g. a stray fresh) account.
    @State private var signInInstead = false
    /// Re-evaluates the time-based `browserConnected` / `browserReconnecting` while Settings is open.
    @State private var tick = 0
    private let heartbeat = Timer.publish(every: 15, on: .main, in: .common).autoconnect()

    /// The panel is as tall as its content, which on a laptop screen is taller than the screen.
    /// Cap it to the visible screen, scroll the settings, and keep Quit / Done pinned at the bottom.
    private var maxPanelHeight: CGFloat {
        (NSScreen.main?.visibleFrame.height ?? 800) - 120
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView { settingsContent.padding(16) }
            Divider()
            footer.padding(12)
        }
        .frame(width: 340)
        .frame(maxHeight: maxPanelHeight)
        .tint(Theme.accent)   // buttons follow the app accent, not the OS accent colour
        .onAppear { urlDraft = appState.apiBaseUrl }
        .onReceive(heartbeat) { _ in tick &+= 1 }   // keep the browser-connection line current
    }

    @ViewBuilder private var settingsContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Settings").font(.headline)

            VStack(alignment: .leading, spacing: 8) {
                Label("Account", systemImage: "person.crop.circle")
                    .font(.subheadline).fontWeight(.medium)

                // Plan state -- always visible once the account has loaded.
                VStack(alignment: .leading, spacing: 2) {
                    if let email = appState.account?.email {
                        Text(email).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    }
                    Text(subscriptionLine).font(.caption).foregroundColor(.secondary)
                }

                if appState.account?.isPro == true {
                    Button("Manage Subscription") { Task { await appState.openBillingPortal() } }
                        .controlSize(.small)
                } else {
                    Button("Subscribe to Pro") { appState.openUpgradePage() }
                        .buttonStyle(.borderedProminent).tint(Theme.accent).controlSize(.small)
                }

                if appState.account?.email != nil {
                    HStack(spacing: 12) {
                        Button("Sign Out", role: .destructive) { appState.unpair(); dismiss() }
                            .controlSize(.small)
                        Button("Sign out other devices") { Task { await appState.signOutOtherDevices() } }
                            .controlSize(.small)
                            .help("Revokes every other browser, phone, or Mac signed into this account. This one stays signed in.")
                    }
                } else if signInInstead {
                    Text("Sign in to an account you already have. This replaces what's on this Mac — its ideas come from that account.")
                        .font(.caption).foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 2)
                    EmailCodeForm(
                        title: "Sign in to your Thread account",
                        sendCode: { await appState.sendSignInCode(email: $0) },
                        verify: { await appState.signIn(email: $0, code: $1) },
                        onDone: { dismiss() },
                        prefillEmail: appState.claimEmailInUse ?? CredentialStore.lastKnownEmail ?? ""
                    )
                    Button("Add an email to this account instead") { signInInstead = false; appState.claimEmailInUse = nil }
                        .buttonStyle(.plain).font(.caption2).foregroundStyle(.secondary)
                } else {
                    Text("Add your email to check out on the website, then sign back in on any device — your ideas stay put.")
                        .font(.caption).foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 2)
                    EmailCodeForm(
                        title: "Add your email",
                        sendCode: { await appState.sendClaimCode(email: $0) },
                        verify: { await appState.claimEmail(email: $0, code: $1) }
                    )
                    if appState.claimEmailInUse != nil {
                        Button("Sign in to that account instead") {
                            appState.authError = nil
                            signInInstead = true
                        }
                        .buttonStyle(.borderedProminent).tint(Theme.accent).controlSize(.small)
                    } else {
                        Button("Already have a Thread account? Sign in") { signInInstead = true }
                            .buttonStyle(.plain).font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }

            Divider()

            GeneralSection()

            Divider()

            CaptureSection()

            Divider()

            if appState.isPaired {
                DataSection()

                Divider()
            }

            AppearanceSection()

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Label("Browser extension", systemImage: "puzzlepiece.extension")
                    .font(.subheadline).fontWeight(.medium)
                Text("The extension connects automatically for a couple of minutes after Thread launches, then captures on its own.")
                    .font(.caption).foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                // Live connection state, derived from the extension's heartbeat (it pings every
                // minute while alive + on this account) -- not a sticky flag. So it self-heals
                // after a sign-out/in and goes stale on its own if the browser closes.
                HStack(spacing: 8) {
                    if appState.browserConnected {
                        Label("Browser connected", systemImage: "checkmark.circle.fill")
                            .font(.caption).foregroundStyle(.green)
                    } else if appState.browserReconnecting {
                        Label("Reconnecting…", systemImage: "arrow.triangle.2.circlepath")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        Button("Connect a browser") { appState.openPairingWindow() }
                            .font(.caption)
                        if appState.isPairingWindowOpen {
                            Label("Listening…", systemImage: "dot.radiowaves.left.and.right")
                                .font(.caption2).foregroundStyle(Theme.accent)
                        }
                    }
                }
                .padding(.top, 2)

                if !appState.browserConnected && !appState.browserReconnecting && !appState.isPairingWindowOpen {
                    Text("No browser connected.")
                        .font(.caption2).foregroundColor(.secondary)
                }

                if !appState.browserConnected, let pairing = appState.pairingString {
                    Text("Or paste this into the extension:")
                        .font(.caption2).foregroundColor(.secondary).padding(.top, 4)
                    HStack {
                        Text(pairing)
                            .font(.system(.caption, design: .monospaced))
                            .lineLimit(1).truncationMode(.middle)
                            .textSelection(.enabled)
                            .padding(6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.gray.opacity(0.1))
                            .cornerRadius(5)
                        Button(copied ? "Copied" : "Copy") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(pairing, forType: .string)
                            copied = true
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                        }
                    }
                }
            }

            Divider()

            HelpSection()

            Divider()

            DisclosureGroup("Advanced", isExpanded: $showAdvanced) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("API base URL").font(.caption).foregroundColor(.secondary)
                    TextField("https://…", text: $urlDraft)
                        .textFieldStyle(.roundedBorder)
                    if let userId = appState.userId {
                        Text("Account: \(userId)").font(.caption2).foregroundColor(.secondary)
                            .textSelection(.enabled)
                    }
                    Button("Unpair this Mac", role: .destructive) {
                        if appState.signOutWouldStrandIdeas { confirmStrandedUnpair = true }
                        else { appState.unpair(); dismiss() }
                    }
                    .font(.caption)
                    .confirmationDialog(
                        "Unpair this Mac?",
                        isPresented: $confirmStrandedUnpair,
                        titleVisibility: .visible
                    ) {
                        Button("Unpair Anyway", role: .destructive) { appState.unpair(); dismiss() }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text("This account has no email attached, so there's no way back to it. \(appState.reachableIdeaCount) idea\(appState.reachableIdeaCount == 1 ? "" : "s") on this Mac will no longer be reachable. Add an email above first to keep them.")
                    }
                }
                .padding(.top, 4)
            }
            .font(.caption)
        }
    }

    @ViewBuilder private var footer: some View {
        HStack {
            Button("Quit Thread") { NSApp.terminate(nil) }
                .controlSize(.small)
                .keyboardShortcut("q", modifiers: .command)
            Spacer()
            Button("Done") {
                // Only write if the field was actually populated and changed. It starts empty
                // and only fills in via .onAppear below -- without the isEmpty guard, opening
                // Settings and hitting Done without touching Advanced would blank the API URL.
                let trimmed = urlDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty && trimmed != appState.apiBaseUrl { appState.setApiBaseUrl(trimmed) }
                dismiss()
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(.defaultAction)
        }
    }

    /// One clean line describing the plan -- the only place subscription state lives in the app.
    private var subscriptionLine: String {
        guard let a = appState.account else { return "Signed in" }
        if a.isAdmin == true {
            return "Admin · unlimited capture · \(a.ideaCount) ideas"
        }
        if a.isPro {
            switch a.status {
            case "canceled":
                if let end = a.currentPeriodEnd { return "Thread Pro · Ends \(Self.shortDate(end))" }
                return "Thread Pro · Ending"
            case "past_due":
                return "Thread Pro · Payment issue"
            default:
                return "Thread Pro"
            }
        }
        let capped = a.ideaCount >= a.ideaCap
        return "Thread Free · \(a.ideaCount) of \(a.ideaCap) ideas" + (capped ? " · limit reached" : "")
    }

    private static func shortDate(_ iso: String) -> String {
        let parsers = [ISO8601DateFormatter(), { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()]
        for p in parsers {
            if let d = p.date(from: iso) {
                let out = DateFormatter(); out.dateStyle = .medium
                return out.string(from: d)
            }
        }
        return String(iso.prefix(10))
    }
}

/// Settings ▸ Help — the list-symbol legend inline, plus a link to the full web guide
/// (get-started #help). The legend mirrors IdeaRowView.glyphSymbol exactly.
private struct HelpSection: View {
    private let symbols: [(name: String, color: Color, label: String)] = [
        ("circle", .secondary, "Developing"),
        ("circle.dotted", .secondary, "Open question"),
        ("circle.bottomhalf.filled", Theme.stateColor("contested"), "Contested — act now"),
        ("circle.fill", .secondary.opacity(0.5), "Established"),
        ("circle.slash", .secondary.opacity(0.5), "Rejected"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Help", systemImage: "questionmark.circle")
                .font(.subheadline).fontWeight(.medium)
            Text("What the list symbols mean:")
                .font(.caption).foregroundColor(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                ForEach(symbols, id: \.label) { sym in
                    HStack(spacing: 7) {
                        Image(systemName: sym.name)
                            .font(.system(size: 11))
                            .foregroundStyle(sym.color)
                            .frame(width: 14)
                        Text(sym.label).font(.caption)
                    }
                }
            }
            .padding(.leading, 2)
            Button("Open the full guide") {
                if let u = URL(string: "\(AppState.marketingBaseURL)/get-started#help") {
                    NSWorkspace.shared.open(u)
                }
            }
            .font(.caption)
            .padding(.top, 2)
        }
    }
}

/// Settings ▸ Appearance — accent colour, row density, snippet lines. Matches the design mock.
/// Open at login, the recall shortcut, and updates -- the "does it just work every day" settings.
private struct GeneralSection: View {
    @State private var launchAtLogin = LaunchAtLogin.isEnabled
    @State private var loginNeedsApproval = LaunchAtLogin.needsApproval
    @State private var shortcut = RecallShortcut.current
    @State private var autoUpdate = AppDelegate.shared?.updater.automaticallyChecks ?? false
    @State private var spotlight = SpotlightIndex.isEnabled

    private var updater: Updater? { AppDelegate.shared?.updater }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("General", systemImage: "gearshape")
                .font(.subheadline).fontWeight(.medium)

            Toggle("Open Thread at login", isOn: $launchAtLogin)
                .font(.caption)
                .onChange(of: launchAtLogin) { _, on in
                    LaunchAtLogin.setEnabled(on)
                    launchAtLogin = LaunchAtLogin.isEnabled
                    loginNeedsApproval = LaunchAtLogin.needsApproval
                }
            Toggle("Show my ideas in Spotlight", isOn: $spotlight)
                .font(.caption)
                .help("Indexed on this Mac only. Turning it off removes them from Spotlight.")
                .onChange(of: spotlight) { _, on in
                    SpotlightIndex.isEnabled = on
                    if on, let ideas = AppDelegate.shared?.appState.thinkingState?.currentIdeas {
                        SpotlightIndex.sync(ideas)
                    }
                }

            if loginNeedsApproval {
                Button("Allow in System Settings…") { LaunchAtLogin.openSystemSettings() }
                    .font(.caption2)
            }

            HStack(spacing: 10) {
                Text("Recall").font(.caption).foregroundColor(.secondary).frame(width: 70, alignment: .leading)
                Picker("", selection: $shortcut) {
                    ForEach(RecallShortcut.allCases) { Text($0.symbol).tag($0) }
                }
                .labelsHidden().pickerStyle(.menu).frame(width: 150)
                .onChange(of: shortcut) { _, new in RecallShortcut.current = new }
                Spacer(minLength: 0)
            }
            if let note = shortcut.note {
                Text(note).font(.caption2).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let updater, updater.isConfigured {
                HStack(spacing: 12) {
                    Toggle("Update automatically", isOn: $autoUpdate)
                        .font(.caption)
                        .onChange(of: autoUpdate) { _, on in updater.automaticallyChecks = on }
                    Button("Check Now") { updater.checkForUpdates() }
                        .controlSize(.small)
                }
            }
            Text("Version \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev")")
                .font(.caption2).foregroundStyle(.tertiary)
        }
        .onAppear {
            launchAtLogin = LaunchAtLogin.isEnabled
            loginNeedsApproval = LaunchAtLogin.needsApproval
        }
    }
}

private struct AppearanceSection: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Appearance", systemImage: "paintpalette")
                .font(.subheadline).fontWeight(.medium)

            HStack(spacing: 10) {
                Text("Accent").font(.caption).foregroundColor(.secondary).frame(width: 70, alignment: .leading)
                ForEach(AccentChoice.allCases) { choice in
                    AccentSwatch(choice: choice, selected: appState.accent == choice)
                        .onTapGesture { appState.accent = choice }
                }
                Spacer(minLength: 0)
            }

            HStack(spacing: 10) {
                Text("Density").font(.caption).foregroundColor(.secondary).frame(width: 70, alignment: .leading)
                Picker("", selection: $appState.density) {
                    ForEach(Density.allCases) { Text($0.label).tag($0) }
                }
                .labelsHidden().pickerStyle(.menu).frame(width: 150)
                Spacer(minLength: 0)
            }

            Toggle(isOn: $appState.showSnippets) {
                Text("Show snippet lines").font(.caption)
            }
            .toggleStyle(.switch).controlSize(.small)
        }
    }
}

private struct AccentSwatch: View {
    let choice: AccentChoice
    let selected: Bool

    var body: some View {
        Circle()
            .fill(choice.color)
            .frame(width: 20, height: 20)
            .overlay(checkmark)
            .overlay(ring)
            .contentShape(Circle())
            .help(choice.label)
    }

    @ViewBuilder private var checkmark: some View {
        if selected {
            Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
        }
    }

    private var ring: some View {
        Circle()
            .stroke(Color.primary.opacity(selected ? 0.85 : 0), lineWidth: 1.5)
            .padding(-2.5)
    }
}


/// What Thread captures on this Mac, beyond the browser: AI tools whose history is in files here,
/// read natively the moment it changes, one switch per tool.
private struct CaptureSection: View {
    @EnvironmentObject var appState: AppState
    @State private var detected: [(source: String, name: String)] = []
    @State private var enabled: [String: Bool] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("AI tools on this Mac", systemImage: "cpu")
                .font(.subheadline).fontWeight(.medium)

            if detected.isEmpty {
                Text("No local AI tool history found yet (Claude Code, Codex, Gemini CLI, Copilot Chat, LM Studio, Jan…). Thread starts capturing one as soon as you use it.")
                    .font(.caption).foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Captured the moment a conversation changes. Read-only; earlier history isn't sent — use Recover for that.")
                    .font(.caption).foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(detected, id: \.source) { tool in
                    Toggle(tool.name, isOn: Binding(
                        get: { enabled[tool.source] ?? true },
                        set: { on in
                            enabled[tool.source] = on
                            CaptureSettings.setLocalSource(tool.source, enabled: on)
                        }
                    ))
                    .font(.caption)
                }
            }

            Text("ChatGPT and Claude desktop apps: their chat history is encrypted or kept on their servers, and reading their windows proved unreliable — use them on the web with the Thread extension, or select the conversation and choose Services › Capture in Thread.")
                .font(.caption2).foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .onAppear {
            detected = AppDelegate.shared?.localHistory?.detectedSources() ?? []
            enabled = Dictionary(uniqueKeysWithValues: detected.map { ($0.source, CaptureSettings.isLocalSourceEnabled($0.source)) })
        }
    }
}


// MARK: - Your data

/// What Thread holds, who else receives it, how long it's kept -- read from the server, so it
/// can't drift from what the code does -- plus a full export and a provable delete-everything.
private struct DataSection: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var confirming = false
    @State private var typed = ""
    @State private var needsBillingAck = false
    @State private var acknowledgeBilling = false
    @State private var busy = false
    @State private var message: String?

    private let phrase = "delete everything"

    private func n(_ v: Int) -> String { v.formatted() }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundColor(.secondary)
            Spacer(minLength: 8)
            Text(value).multilineTextAlignment(.trailing)
        }
        .font(.caption)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Your data", systemImage: "lock.shield")
                .font(.subheadline).fontWeight(.medium)

            if let s = appState.dataSummary {
                VStack(alignment: .leading, spacing: 4) {
                    row("Conversations", "\(n(s.stored.conversations)) · \(n(s.stored.messages)) messages, kept in full")
                    row("Ideas", n(s.stored.ideas))
                    row("Thoughts behind them", n(s.stored.thoughts + s.stored.setAsideThoughts))
                    row("Meaning-vectors", n(s.stored.vectors))
                    row("Your corrections", n(s.stored.corrections))
                    if s.stored.waitingForAi > 0 { row("Waiting for the AI", n(s.stored.waitingForAi)) }
                    row("Size on the server", ByteCountFormatter.string(fromByteCount: Int64(s.stored.bytes), countStyle: .file))
                }

                Text("Who else receives it").font(.caption).fontWeight(.medium).padding(.top, 2)
                ForEach(s.processors) { p in
                    VStack(alignment: .leading, spacing: 1) {
                        Text(p.name).font(.caption).fontWeight(.medium)
                        Text("\(p.purpose) Receives: \(p.receives)")
                            .font(.caption2).foregroundColor(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Text("How long it's kept").font(.caption).fontWeight(.medium).padding(.top, 2)
                Group {
                    Text(s.retention.rawConversations)
                    Text(s.retention.backups)
                }
                .font(.caption2).foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            } else if let e = appState.dataSummaryError {
                Text("Couldn't load this right now: \(e)")
                    .font(.caption).foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ProgressView().controlSize(.small)
            }

            HStack(spacing: 8) {
                Button("Export everything…") { export() }
                Button("Delete everything…", role: .destructive) { confirming.toggle() }
            }
            .controlSize(.small)

            if confirming { confirmBox }
        }
        .task { await appState.loadDataSummary() }
    }

    private var confirmBox: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let s = appState.dataSummary {
                Text("This permanently deletes \(n(s.stored.conversations)) conversations (\(n(s.stored.messages)) messages), \(n(s.stored.ideas)) ideas, \(n(s.stored.vectors)) vectors and \(n(s.stored.corrections)) corrections from Thread's server, your account, and everything Thread keeps on this Mac. It can't be undone.")
                    .font(.caption)
                    .fixedSize(horizontal: false, vertical: true)
                Text(s.retention.backups)
                    .font(.caption2).foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if needsBillingAck {
                Toggle("I understand my subscription keeps billing until I cancel it.", isOn: $acknowledgeBilling)
                    .font(.caption)
            }
            TextField("Type “\(phrase)”", text: $typed)
                .textFieldStyle(.roundedBorder)
            HStack {
                Button("Cancel") { confirming = false; typed = ""; message = nil }
                Spacer()
                Button("Delete everything", role: .destructive) { deleteEverything() }
                    .disabled(typed.trimmingCharacters(in: .whitespaces).lowercased() != phrase || busy || (needsBillingAck && !acknowledgeBilling))
            }
            .controlSize(.small)
            if let message {
                Text(message).font(.caption).foregroundColor(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(10)
        .background(Color.red.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }

    private func export() {
        Task {
            guard let tmp = await appState.exportDataFile() else { return }
            let panel = NSSavePanel()
            panel.nameFieldStringValue = "thread-export.json"
            panel.allowedContentTypes = [.json]
            if panel.runModal() == .OK, let dest = panel.url {
                try? FileManager.default.removeItem(at: dest)
                try? FileManager.default.copyItem(at: tmp, to: dest)
            }
            try? FileManager.default.removeItem(at: tmp)
        }
    }

    private func deleteEverything() {
        busy = true
        message = nil
        Task {
            do {
                let r = try await appState.deleteEverything(acknowledgeSubscription: acknowledgeBilling)
                busy = false
                let alert = NSAlert()
                alert.messageText = "Everything was deleted"
                var text = "Removed from Thread's server: \(r.data.conversations) conversations (\(r.data.messages) messages), \(r.data.ideas) ideas, \(r.data.vectors) vectors, \(r.data.corrections) corrections, and your account. Removed from this Mac: its copy of your ideas, your sign-in and the Spotlight entries.\n\n\(r.backups)"
                if r.subscriptionStillActive {
                    text += "\n\nYour subscription is still active with our payment processor — cancel it from the link in your receipt email."
                }
                alert.informativeText = text
                alert.runModal()
                dismiss()
            } catch let APIError.http(status, msg) where status == 409 {
                busy = false
                needsBillingAck = true
                message = msg
            } catch {
                busy = false
                message = error.localizedDescription
            }
        }
    }
}
