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

            VStack(alignment: .leading, spacing: 6) {
                Label("Account", systemImage: "person.crop.circle")
                    .font(.subheadline).fontWeight(.medium)
                if let email = appState.account?.email {
                    Text(email).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    Text(appState.planLabel == "Cloud" ? "Signed in" : appState.planLabel)
                        .font(.caption).foregroundColor(.secondary)
                    HStack(spacing: 8) {
                        if appState.account?.isPro == true {
                            Button("Manage billing") { Task { await appState.openBillingPortal() } }
                                .controlSize(.small)
                        } else {
                            Button("Upgrade to Pro") { appState.openUpgradePage() }
                                .controlSize(.small)
                        }
                        Button("Sign out", role: .destructive) { appState.unpair(); dismiss() }
                            .controlSize(.small)
                    }
                } else {
                    Text("This Mac uses an account with no email. Add one to buy Pro on the website and sign in on other devices — your ideas stay.")
                        .font(.caption).foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
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
                Text("While Thread is running, the extension connects automatically. If it can't, paste this pairing string into the extension popup.")
                    .font(.caption).foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

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

            HStack {
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
        .onAppear { urlDraft = appState.apiBaseUrl }
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
