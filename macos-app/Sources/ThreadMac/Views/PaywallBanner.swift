import SwiftUI

/// Soft paywall: shown above the list once the trial ends. Reads still work (you can recover
/// everything you've captured); this is the nudge to subscribe so new capture resumes.
struct PaywallBanner: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "lock.fill").font(.system(size: 11)).foregroundStyle(Theme.accent)
                Text("Your Thread trial has ended").font(.system(size: 12, weight: .semibold))
            }
            Text("Everything you've captured is still here. Subscribe to keep adding new thinking from your AI chats.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button {
                    Task { await appState.openCheckout() }
                } label: {
                    Text(appState.billingBusy ? "Opening…" : "Upgrade to Pro")
                }
                .buttonStyle(.borderedProminent).tint(Theme.accent).controlSize(.small)
                .disabled(appState.billingBusy)

                Button("Manage billing") { Task { await appState.openBillingPortal() } }
                    .controlSize(.small)

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
