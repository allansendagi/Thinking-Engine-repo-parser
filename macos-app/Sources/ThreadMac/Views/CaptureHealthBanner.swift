import SwiftUI

/// The one place Thread admits uncertainty. Shown above the list when `/v1/capture-health` says a
/// sensor is degraded or recent thinking is stuck identity-unresolved. It never implies data was
/// lost or corrupted -- the machinery behind it (provisional/committed, UNRESOLVED) exists so that
/// "I'm not sure" is the worst case, never a wrong merge. Dismissible for the session.
struct CaptureHealthBanner: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        if let notice = appState.captureHealthNotice {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 11)).foregroundStyle(Theme.ink(0.55))
                    Text(notice.title)
                        .font(.system(size: 12, weight: .semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Button {
                        appState.dismissCaptureHealthNotice()
                    } label: {
                        Image(systemName: "xmark").font(.system(size: 10, weight: .semibold))
                    }
                    .buttonStyle(.plain).foregroundStyle(Theme.ink(0.4))
                    .help("Dismiss until next launch")
                }
                if let detail = notice.detail {
                    Text(detail)
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.ink(0.04), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.ink(0.08)))
            .padding(.horizontal, 12)
            .padding(.top, 8)
        }
    }
}
