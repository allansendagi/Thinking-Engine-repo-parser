import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct SettingsView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) private var dismiss
    /// In the main window's Settings pane rather than a sheet: no Done button, and Quit lives in the form.
    var embedded = false
    @State private var copied = false
    @State private var showAdvanced = false
    @State private var confirmStrandedUnpair = false
    /// On an anonymous account: switch the email form from "attach to this account" to "sign in to
    /// a different one". The way back when this Mac is on the wrong (e.g. a stray fresh) account.
    @State private var signInInstead = false
    /// Re-evaluates the time-based `browserConnected` / `browserReconnecting` while Settings is open.
    @State private var tick = 0
    private let heartbeat = Timer.publish(every: 15, on: .main, in: .common).autoconnect()

    /// As a sheet, the panel is as tall as its content, which on a laptop screen is taller than the
    /// screen. Cap it to the visible screen; the form scrolls, and Quit / Done stay pinned below.
    private var maxPanelHeight: CGFloat {
        (NSScreen.main?.visibleFrame.height ?? 800) - 120
    }

    var body: some View {
        VStack(spacing: 0) {
            if !embedded {
                Text("Settings").font(.headline).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 28).padding(.top, 16)
            }
            Form { settingsContent }
                .formStyle(.grouped).tint(Theme.accent)
            if !embedded {
                Divider()
                footer.padding(12)
            }
        }
        .frame(minWidth: embedded ? nil : 400, idealWidth: embedded ? nil : 440)
        .frame(maxHeight: embedded ? .infinity : maxPanelHeight)
        .onReceive(heartbeat) { _ in tick &+= 1 }   // keep the browser-connection line current
    }

    @ViewBuilder private var settingsContent: some View {
        accountSection
        GeneralSection()
        CaptureSection()
        if !appState.olderHistory.isEmpty {
            Section {
                OlderHistoryRows()
            } header: {
                Text("Earlier conversations")
            } footer: {
                Text("Recover brings in your recent conversations first. These are the ones before that.")
            }
        }
        if appState.isPaired { DataSection() }
        AppearanceSection()
        extensionSection
        LearningSection { dismiss() }
        HelpSection()
        Section {
            DisclosureGroup("Advanced", isExpanded: $showAdvanced) {
                // The server address and internal account id are deliberately not shown: they're
                // nothing a person needs, and an edited address silently breaks the app. A
                // developer can still point a build elsewhere with
                // `defaults write com.thread.mac thread.apiBaseUrl <url>`.
                Button("Unpair This Mac", role: .destructive) {
                    if appState.signOutWouldStrandIdeas { confirmStrandedUnpair = true }
                    else { appState.unpair(); dismiss() }
                }
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
        }
        if embedded {
            Section { Button("Quit Thread") { AppQuit.now() } }
        }
    }

    // MARK: account

    private var accountSection: some View {
        Section("Account") {
            if let email = appState.account?.email {
                LabeledContent("Email") { Text(email).textSelection(.enabled) }
            }
            LabeledContent("Plan", value: subscriptionLine)

            // Plan state -- always visible once the account has loaded.
            if appState.account?.isPro == true {
                Button("Manage Subscription") { Task { await appState.openBillingPortal() } }
            } else {
                Button("Subscribe to Pro") { appState.openUpgradePage() }
                    .buttonStyle(.borderedProminent)
            }

            if appState.account?.email != nil {
                Button("Sign Out", role: .destructive) { appState.unpair(); dismiss() }
                Button("Sign Out Other Devices") { Task { await appState.signOutOtherDevices() } }
                    .help("Revokes every other browser, phone, or Mac signed into this account. This one stays signed in.")
            } else if signInInstead {
                Text("Sign in to an account you already have. This replaces what's on this Mac — its ideas come from that account.")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                EmailCodeForm(
                    title: "Sign in to your Thread account",
                    sendCode: { await appState.sendSignInCode(email: $0) },
                    verify: { await appState.signIn(email: $0, code: $1) },
                    onDone: { dismiss() },
                    prefillEmail: appState.claimEmailInUse ?? CredentialStore.lastKnownEmail ?? ""
                )
                Button("Add an email to this account instead") { signInInstead = false; appState.claimEmailInUse = nil }
                    .buttonStyle(.link)
            } else {
                Text("Add your email to check out on the website, then sign back in on any device — your ideas stay put.")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
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
                    .buttonStyle(.borderedProminent)
                } else {
                    Button("Already have a Thread account? Sign in") { signInInstead = true }
                        .buttonStyle(.link)
                }
            }
        }
    }

    // MARK: browser extension

    private var extensionSection: some View {
        Section("Browser extension") {
            Text("The extension connects automatically for a couple of minutes after Thread launches, then captures on its own.")
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            // Live connection state, derived from the extension's heartbeat (it pings every
            // minute while alive + on this account) -- not a sticky flag. So it self-heals
            // after a sign-out/in and goes stale on its own if the browser closes.
            if appState.browserConnected {
                Label("Browser connected", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
            } else if appState.browserReconnecting {
                Label("Reconnecting…", systemImage: "arrow.triangle.2.circlepath").foregroundStyle(.secondary)
            } else {
                Button("Connect a Browser") { appState.openPairingWindow() }
                if appState.isPairingWindowOpen {
                    Label("Listening…", systemImage: "dot.radiowaves.left.and.right").foregroundStyle(.tint)
                } else {
                    Text("No browser connected.").foregroundStyle(.secondary)
                }
            }

            if !appState.browserConnected, let pairing = appState.pairingString {
                LabeledContent("Or paste this into the extension:") {
                    HStack {
                        Text(pairing)
                            .font(.system(.callout, design: .monospaced))
                            .lineLimit(1).truncationMode(.middle)
                            .textSelection(.enabled)
                        Button(copied ? "Copied" : "Copy") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(pairing, forType: .string)
                            copied = true
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder private var footer: some View {
        HStack {
            Button("Quit Thread") { AppQuit.now() }
                .keyboardShortcut("q", modifiers: .command)
            Spacer()
            Button("Done") { dismiss() }
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
        Section("Help") {
            Text("What the list symbols mean:").font(.callout).foregroundStyle(.secondary)
            ForEach(symbols, id: \.label) { sym in
                Label { Text(sym.label) } icon: { Image(systemName: sym.name).foregroundStyle(sym.color) }
            }
            Button("Open the Full Guide") {
                if let u = URL(string: "\(AppState.marketingBaseURL)/get-started#help") {
                    NSWorkspace.shared.open(u)
                }
            }
        }
    }
}

/// Settings ▸ Appearance — accent colour, row density, snippet lines. Matches the design mock.
/// Open at login, the recall shortcut, and updates -- the "does it just work every day" settings.
private struct GeneralSection: View {
    @State private var launchAtLogin = LaunchAtLogin.isEnabled
    @State private var loginNeedsApproval = LaunchAtLogin.needsApproval
    @State private var shortcut = RecallShortcut.current
    @State private var voiceShortcut = VoiceShortcut.current
    @State private var autoUpdate = AppDelegate.shared?.updater.automaticallyChecks ?? false
    @State private var spotlight = SpotlightIndex.isEnabled
    @State private var widget = WidgetFeed.isEnabled

    private var updater: Updater? { AppDelegate.shared?.updater }

    var body: some View {
        Section("General") {
            Toggle("Open Thread at login", isOn: $launchAtLogin)
                .onChange(of: launchAtLogin) { _, on in
                    LaunchAtLogin.setEnabled(on)
                    launchAtLogin = LaunchAtLogin.isEnabled
                    loginNeedsApproval = LaunchAtLogin.needsApproval
                }
            if loginNeedsApproval {
                Button("Allow in System Settings…") { LaunchAtLogin.openSystemSettings() }
            }

            Toggle("Show my ideas in Spotlight", isOn: $spotlight)
                .help("Indexed on this Mac only. Turning it off removes them from Spotlight.")
                .onChange(of: spotlight) { _, on in
                    SpotlightIndex.isEnabled = on
                    if on, let ideas = AppDelegate.shared?.appState.thinkingState?.currentIdeas {
                        SpotlightIndex.sync(ideas)
                    }
                }

            Toggle("Show my recent ideas in the Thread widget", isOn: $widget)
                .help("Only the newest idea titles are shared with the widget, on this Mac. Turning it off clears them.")
                .onChange(of: widget) { _, on in
                    WidgetFeed.isEnabled = on
                    if let app = AppDelegate.shared?.appState {
                        WidgetFeed.sync(state: app.isPaired ? app.thinkingState : nil, excluding: app.maybeIdeaIds)
                    }
                }

            Picker("Recall", selection: $shortcut) {
                ForEach(RecallShortcut.allCases) { Text($0.symbol).tag($0) }
            }
            .onChange(of: shortcut) { _, new in RecallShortcut.current = new }
            if let note = shortcut.note {
                Text(note).font(.footnote).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Picker("Voice", selection: $voiceShortcut) {
                ForEach(VoiceShortcut.allCases) { Text($0.symbol).tag($0) }
            }
            .accessibilityLabel("Voice capture shortcut")
            .onChange(of: voiceShortcut) { _, new in VoiceShortcut.current = new }
            Text("Speak a thought from any app. Your voice is turned into text on this Mac and never sent anywhere; the text is captured like anything else you add.")
                .font(.footnote).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if let updater, updater.isConfigured {
                Toggle("Update automatically", isOn: $autoUpdate)
                    .onChange(of: autoUpdate) { _, on in updater.automaticallyChecks = on }
                Button("Check Now") { updater.checkForUpdates() }
            }
            LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev")
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
        Section("Appearance") {
            LabeledContent("Accent") {
                HStack(spacing: 10) {
                    ForEach(AccentChoice.allCases) { choice in
                        Button { appState.accent = choice } label: {
                            AccentSwatch(choice: choice, selected: appState.accent == choice)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(choice.label) accent")
                        .accessibilityAddTraits(appState.accent == choice ? .isSelected : [])
                    }
                }
            }
            Picker("Density", selection: $appState.density) {
                ForEach(Density.allCases) { Text($0.label).tag($0) }
            }
            Toggle("Show snippet lines", isOn: $appState.showSnippets)
        }
    }
}

/// One accent colour option: a filled circle, ringed with a checkmark when chosen.
private struct AccentSwatch: View {
    let choice: AccentChoice
    let selected: Bool

    var body: some View {
        Circle()
            .fill(choice.color)
            .frame(width: 20, height: 20)
            .overlay {
                if selected {
                    Image(systemName: "checkmark").font(.caption2.weight(.bold)).foregroundStyle(.white)
                }
            }
            .overlay(Circle().stroke(Color.primary.opacity(selected ? 0.85 : 0), lineWidth: 1.5).padding(-2.5))
            .contentShape(Circle())
            .help(choice.label)
    }
}

/// What Thread captures on this Mac, beyond the browser: AI tools whose history is in files here,
/// read natively the moment it changes, one switch per tool.
private struct CaptureSection: View {
    @EnvironmentObject var appState: AppState
    @State private var detected: [(source: String, name: String)] = []
    @State private var enabled: [String: Bool] = [:]

    var body: some View {
        Section {
            if detected.isEmpty {
                Text("No local AI tool history found yet (Claude Code, Codex, Gemini CLI, Copilot Chat, LM Studio, Jan…). Thread starts capturing one as soon as you use it.")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Captured the moment a conversation changes. Read-only; earlier history isn't sent — use Recover for that.")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(detected, id: \.source) { tool in
                    Toggle(tool.name, isOn: Binding(
                        get: { enabled[tool.source] ?? true },
                        set: { on in
                            enabled[tool.source] = on
                            CaptureSettings.setLocalSource(tool.source, enabled: on)
                        }
                    ))
                }
            }
        } header: {
            Text("AI tools on this Mac")
        } footer: {
            Text("ChatGPT and Claude desktop apps: their chat history is encrypted or kept on their servers, and reading their windows proved unreliable — use them on the web with the Thread extension, or select the conversation and choose Services › Capture in Thread.")
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

    var body: some View {
        Group {
            Section("Your data") {
                if let s = appState.dataSummary {
                    LabeledContent("Conversations", value: "\(n(s.stored.conversations)) · \(n(s.stored.messages)) messages, kept in full")
                    LabeledContent("Ideas", value: n(s.stored.ideas))
                    LabeledContent("Thoughts behind them", value: n(s.stored.thoughts + s.stored.setAsideThoughts))
                    LabeledContent("Meaning-vectors", value: n(s.stored.vectors))
                    LabeledContent("Your corrections", value: n(s.stored.corrections))
                    if s.stored.waitingForAi > 0 { LabeledContent("Waiting for the AI", value: n(s.stored.waitingForAi)) }
                    LabeledContent("Size on the server", value: ByteCountFormatter.string(fromByteCount: Int64(s.stored.bytes), countStyle: .file))
                } else if let e = appState.dataSummaryError {
                    Text("Couldn't load this right now: \(e)")
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    ProgressView().controlSize(.small)
                }
            }

            if let s = appState.dataSummary {
                Section("Who else receives it") {
                    ForEach(s.processors) { p in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(p.name).fontWeight(.medium)
                            Text("\(p.purpose) Receives: \(p.receives)")
                                .font(.footnote).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                Section("How long it's kept") {
                    Text(s.retention.rawConversations)
                    Text(s.retention.backups)
                }
                .font(.footnote).foregroundStyle(.secondary)
            }

            Section {
                Button("Export Everything…") { export() }
                Button("Delete Everything…", role: .destructive) { confirming.toggle() }
            }

            if confirming { confirmSection }
        }
        .task { await appState.loadDataSummary() }
    }

    /// Deleting everything asks for the words, and for acknowledgement that a subscription keeps
    /// billing: a form section of its own, in the same place the button was.
    private var confirmSection: some View {
        Section("Delete everything") {
            if let s = appState.dataSummary {
                Text("This permanently deletes \(n(s.stored.conversations)) conversations (\(n(s.stored.messages)) messages), \(n(s.stored.ideas)) ideas, \(n(s.stored.vectors)) vectors and \(n(s.stored.corrections)) corrections from Thread's server, your account, and everything Thread keeps on this Mac. It can't be undone.")
                    .fixedSize(horizontal: false, vertical: true)
                Text(s.retention.backups)
                    .font(.footnote).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if needsBillingAck {
                Toggle("I understand my subscription keeps billing until I cancel it.", isOn: $acknowledgeBilling)
            }
            TextField("Type “\(phrase)”", text: $typed)
            HStack {
                Button("Cancel") { confirming = false; typed = ""; message = nil }
                Spacer()
                Button("Delete Everything", role: .destructive) { deleteEverything() }
                    .disabled(typed.trimmingCharacters(in: .whitespaces).lowercased() != phrase || busy || (needsBillingAck && !acknowledgeBilling))
            }
            if let message {
                Text(message).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func export() {
        Task {
            guard let tmp = await appState.exportDataFile() else {
                // The reason lives in dataSummaryError, which this screen only shows when the summary
                // itself failed -- so a failed export used to look like nothing happening.
                showExportAlert("Couldn't export your data", appState.dataSummaryError ?? "The export didn't complete. Check your connection and try again.")
                return
            }
            defer { try? FileManager.default.removeItem(at: tmp) }
            let panel = NSSavePanel()
            panel.nameFieldStringValue = "thread-export.json"
            panel.allowedContentTypes = [.json]
            // Thread is a menu-bar app: without activating it, a save panel can open BEHIND other
            // windows -- it looks like nothing happened, and each further click stacks another one.
            // The import picker (chooseExportFile) does the same two things for the same reason.
            NSApp.activate(ignoringOtherApps: true)
            panel.level = .modalPanel
            guard panel.runModal() == .OK, let dest = panel.url else { return }
            do {
                try? FileManager.default.removeItem(at: dest)
                try FileManager.default.copyItem(at: tmp, to: dest)
            } catch {
                showExportAlert("Couldn't save the file", error.localizedDescription)
            }
        }
    }

    private func showExportAlert(_ title: String, _ text: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        alert.runModal()
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

/// What Thread has learned about how this person thinks, and a way to teach it more right now.
private struct LearningSection: View {
    @EnvironmentObject var appState: AppState
    let closeSettings: () -> Void

    var body: some View {
        Section("Learning") {
            Text(summary)
                .font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button("Teach Thread Now") {
                closeSettings()
                Task { await appState.startLesson() }
            }
            .disabled(!appState.isPaired)
        }
    }

    private var summary: String {
        let learned = appState.lesson?.learned
            ?? ((appState.taste?.keeps ?? 0) + (appState.taste?.notIdeas ?? 0))
        if learned == 0 {
            return "Each Keep or Not an idea teaches Thread what matters to you. A few quick questions are the fastest way to start."
        }
        var s = "Thread has learned from \(learned) of your answers."
        if let kept = keptRateSentence(
            rate: appState.lesson?.acceptanceRate ?? appState.taste?.acceptanceRate,
            sample: appState.lesson?.acceptanceSample ?? appState.taste?.acceptanceSample
        ) {
            s += " " + kept
        }
        return s
    }
}
