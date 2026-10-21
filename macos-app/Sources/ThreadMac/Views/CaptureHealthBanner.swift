import SwiftUI

/// The one place Thread admits uncertainty. Shown above the list when `/v1/capture-health` says a
/// sensor is degraded or recent thinking is stuck identity-unresolved. It never implies data was
/// lost or corrupted -- the machinery behind it (provisional/committed, UNRESOLVED) exists so that
/// "I'm not sure" is the worst case, never a wrong merge. Dismissible for the session.
struct CaptureHealthBanner: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        if let notice = appState.captureHealthNotice {
            NoticeBox(
                symbol: "exclamationmark.triangle.fill",
                title: notice.title,
                detail: notice.detail,
                dismiss: { appState.dismissCaptureHealthNotice() }
            )
            .padding(.horizontal, 12)
            .padding(.top, 8)
        }
    }
}
