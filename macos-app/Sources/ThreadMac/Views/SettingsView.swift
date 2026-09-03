import AppKit
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var urlDraft = ""
    @State private var copied = false
    @State private var showAdvanced = false

    var body: some View {
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
                }
            }

            Divider()

            AppearanceSection()

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Label("Browser extension", systemImage: "puzzlepiece.extension")
                    .font(.subheadline).fontWeight(.medium)
                Text("The extension connects automatically for a couple of minutes after Thread launches. If it drops, open a fresh window here or paste the pairing string.")
                    .font(.caption).foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 8) {
                    Button("Connect a browser") { appState.openPairingWindow() }
                        .font(.caption)
                    if appState.isPairingWindowOpen {
                        Label("Listening…", systemImage: "dot.radiowaves.left.and.right")
                            .font(.caption2).foregroundStyle(Theme.accent)
                    }
                }
                .padding(.top, 2)

                if let pairing = appState.pairingString {
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
                } else {
                    Text("Not paired yet.").font(.caption).foregroundColor(.secondary)
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
                        appState.unpair()
                        dismiss()
                    }
                    .font(.caption)
                }
                .padding(.top, 4)
            }
            .font(.caption)

            Divider()

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
        .padding(16)
        .frame(width: 340)
        .tint(Theme.accent)   // buttons follow the app accent, not the OS accent colour
        .onAppear { urlDraft = appState.apiBaseUrl }
    }

    /// One clean line describing the plan -- the only place subscription state lives in the app.
    private var subscriptionLine: String {
        guard let a = appState.account else { return "Signed in" }
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
