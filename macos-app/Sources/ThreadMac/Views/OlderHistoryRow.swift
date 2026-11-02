import SwiftUI

/// The quiet "older conversations" line: what a recovery left for later (it brings in the recent
/// part first -- `RecoveryWindow`). One line per source, one button, never a prompt.
struct OlderHistoryRows: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        ForEach(appState.olderHistory, id: \.kind) { older in
            // HStack + Spacer, not LabeledContent: the button sits at the trailing edge both in a
            // grouped Form (Settings) and in a plain stack (the recovery summary).
            HStack {
                Text("\(older.count) older \(Self.sourceName(older.kind)) conversation\(older.count == 1 ? "" : "s")")
                Spacer()
                Button("Bring In") { appState.bringInOlder(older) }
                    .disabled(appState.recoveryRunning)
            }
        }
    }

    static func sourceName(_ kind: BackfillJob.Kind) -> String {
        switch kind {
        case .cursor: return "Cursor"
        case .chatgpt: return "ChatGPT"
        case .claude: return "Claude"
        }
    }
}
