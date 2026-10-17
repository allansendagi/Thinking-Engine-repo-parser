import SwiftUI

/// "Keep" / "Not an idea" -- the two answers that teach Thread what this person keeps. Plain system
/// menu items, used in every idea's context menu so there is one wording everywhere.
struct IdeaVerdictItems: View {
    let ideaId: String
    @EnvironmentObject private var appState: AppState

    var body: some View {
        if !appState.isConfirmed(ideaId) {
            Button { appState.keepIdea(ideaId) } label: { Label("Keep", systemImage: "checkmark") }
        }
        Button(role: .destructive) { appState.notAnIdea(ideaId) } label: {
            Label("Not an idea", systemImage: "xmark")
        }
    }
}

/// Ideas Thread isn't sure are yours to keep. Collapsed by default, nothing is deleted, and one
/// click on Keep moves an idea back into the list.
struct MaybeTray: View {
    let rows: [IdeaRow]
    let selectedId: String?
    let open: (IdeaRow) -> Void
    @State private var expanded = false

    var body: some View {
        if !rows.isEmpty {
            DisclosureGroup(isExpanded: $expanded) {
                ForEach(rows) { r in
                    IdeaRowView(row: r, selected: r.ideaId == selectedId)
                        .contentShape(Rectangle())
                        .onTapGesture { open(r) }
                        .contextMenu { IdeaVerdictItems(ideaId: r.ideaId) }
                }
            } label: {
                Text("Maybe · \(rows.count)").foregroundStyle(.secondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
    }
}
