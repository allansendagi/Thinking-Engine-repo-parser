import SwiftUI

/// A notice above a list: a symbol, a headline, a line of explanation, optional actions, and the
/// standard dismiss button. Only system pieces -- text styles, hierarchical colors, a material fill.
struct NoticeBox<Actions: View>: View {
    let symbol: String
    let title: String
    var detail: String? = nil
    let dismiss: () -> Void
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol)
                .foregroundStyle(.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.headline)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail {
                        Text(detail)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                actions()
            }
            Spacer(minLength: 0)
            Button(action: dismiss) {
                Image(systemName: "xmark.circle.fill").symbolRenderingMode(.hierarchical)
            }
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
            .help("Dismiss until next launch")
            .accessibilityLabel("Dismiss")
            .accessibilityHint("Hides this until the next launch")
        }
        .padding(12)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

extension NoticeBox where Actions == EmptyView {
    init(symbol: String, title: String, detail: String? = nil, dismiss: @escaping () -> Void) {
        self.init(symbol: symbol, title: title, detail: detail, dismiss: dismiss) { EmptyView() }
    }
}
