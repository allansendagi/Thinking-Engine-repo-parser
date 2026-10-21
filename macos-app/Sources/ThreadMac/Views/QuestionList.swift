import SwiftUI

/// An idea's questions: open ones to answer, answered ones struck through. Each is a standard
/// checkbox. A question Thread closed says which answer closed it, so a wrong closure is easy to
/// spot -- and one click on the checkbox reopens it (the person's choice is kept from then on).
struct QuestionList: View {
    let loops: [OpenLoop]
    let toggle: (OpenLoop) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(loops) { loop in
                Toggle(isOn: Binding(get: { loop.resolved }, set: { _ in toggle(loop) })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(loop.statement)
                            .strikethrough(loop.resolved)
                            .foregroundStyle(loop.resolved ? .secondary : .primary)
                        if loop.resolved, let answer = loop.answeredBy {
                            Text("Answered by: “\(answer)”")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .toggleStyle(.checkbox)
            }
        }
    }
}
