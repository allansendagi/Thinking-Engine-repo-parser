import SwiftUI

/// Soft paywall: shown above the list once the Free plan's 25-idea cap is reached. Reads still
/// work (you can recover everything); this is the nudge to upgrade. Payment is on the website.
struct PaywallBanner: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        NoticeBox(
            symbol: "lock.fill",
            title: "You've hit the Free plan's \(appState.account?.ideaCap ?? 25)-idea limit",
            detail: "Everything you've captured is still here. Upgrade to Pro for unlimited capture and AI continuation.",
            dismiss: { appState.dismissPaywallBanner() }
        ) {
            HStack(spacing: 8) {
                Button("Upgrade to Pro") { appState.openUpgradePage() }
                    .buttonStyle(.borderedProminent)
                if appState.account?.email != nil {
                    Button("Manage Billing") { Task { await appState.openBillingPortal() } }
                }
                Button("Refresh") { Task { await appState.refreshAccount() } }
            }
            .controlSize(.small)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }
}
