import SwiftUI

/// Soft paywall: shown above the list once the Free plan's 25-idea cap is reached. Reads still
/// work (you can recover everything); this is the nudge to upgrade. Payment is on the website.
struct PaywallBanner: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "lock.fill").font(.system(size: 11)).foregroundStyle(Theme.accent)
                Text("You've hit the Free plan's \(appState.account?.ideaCap ?? 25)-idea limit")
                    .font(.system(size: 12, weight: .semibold))
                Spacer(minLength: 8)
                Button {
                    appState.dismissPaywallBanner()
                } label: {
                    Image(systemName: "xmark").font(.system(size: 10, weight: .semibold))
                }
                .buttonStyle(.plain).foregroundStyle(Theme.ink(0.4))
                .help("Dismiss until next launch")
            }
            Text("Everything you've captured is still here. Upgrade to Pro for unlimited capture and AI continuation.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button("Upgrade to Pro") { appState.openUpgradePage() }
                    .buttonStyle(.borderedProminent).tint(Theme.accent).controlSize(.small)

                if appState.account?.email != nil {
                    Button("Manage billing") { Task { await appState.openBillingPortal() } }
                        .controlSize(.small)
                }

                Button("Refresh") { Task { await appState.refreshAccount() } }
                    .controlSize(.small)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.accent.opacity(0.12))
        .overlay(Rectangle().frame(height: 1).foregroundStyle(Theme.accent.opacity(0.3)), alignment: .bottom)
    }
}
