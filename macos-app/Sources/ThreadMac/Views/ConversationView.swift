import SwiftUI

/// The captured messages behind an idea -- the "evidence" layer. Opened from a source on an
/// evolution step. Read-only: this is what Thread actually saw, with a link out to the live
/// conversation for the authoritative version.
struct ConversationView: View {
    @EnvironmentObject var appState: AppState
    let transcript: ConversationTranscript

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("\(transcript.sourceLabel) conversation")
                        .font(.system(size: 13, weight: .semibold)).kerning(-0.1)
                    Text("\(transcript.messages.count) message\(transcript.messages.count == 1 ? "" : "s") Thread captured")
                        .font(.system(size: 11)).foregroundStyle(Theme.ink(0.4))
                }
                Spacer(minLength: 0)
                if let raw = transcript.sourceUrl, let url = URL(string: raw) {
                    Link(destination: url) {
                        HStack(spacing: 3) {
                            Text("Open in \(transcript.sourceLabel)")
                            Image(systemName: "arrow.up.right").font(.system(size: 9, weight: .semibold))
                        }
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Theme.accent)
                    }
                    .buttonStyle(.plain)
                }
                Button("Done") { appState.closeConversation() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(16)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(transcript.messages) { m in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(m.role == "user" ? "You" : transcript.sourceLabel)
                                .font(.system(size: 10.5, weight: .semibold))
                                .textCase(.uppercase).kerning(0.4)
                                .foregroundStyle(Theme.ink(m.role == "user" ? 0.55 : 0.4))
                            Text(m.text)
                                .font(.system(size: 12.5)).lineSpacing(2.5)
                                .foregroundStyle(Theme.ink(0.82))
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(m.role == "user" ? Theme.ink(0.035) : .clear,
                                    in: RoundedRectangle(cornerRadius: 8))
                    }
                }
                .padding(16)
            }
        }
        .frame(width: 480, height: 580)
        .background(Theme.panelTint)
    }
}
