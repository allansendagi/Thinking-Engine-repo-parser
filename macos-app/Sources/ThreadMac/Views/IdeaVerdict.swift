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
        Divider()
        Button { Task { await appState.beginCorrection(.merge(ideaId: ideaId)) } } label: {
            Label("Merge Into…", systemImage: "arrow.triangle.merge")
        }
        Button { Task { await appState.beginCorrection(.split(ideaId: ideaId)) } } label: {
            Label("Split…", systemImage: "arrow.triangle.branch")
        }
        Divider()
        Button(role: .destructive) { appState.notAnIdea(ideaId) } label: {
            Label("Not an idea", systemImage: "xmark")
        }
    }
}

/// Right-click on a question row (Open loops, "Still unanswered"): settle it, or go to its idea.
/// A question is part of an idea, so Keep / Not an idea belong to the idea, not here.
struct LoopRowItems: View {
    let row: IdeaRow
    let openIdea: () -> Void
    @EnvironmentObject private var appState: AppState

    var body: some View {
        Button { Task { await appState.toggleLoop(loopId, resolved: true) } } label: {
            Label("Mark as answered", systemImage: "checkmark.circle")
        }
        Button { openIdea() } label: { Label("Open idea", systemImage: "arrow.up.right") }
    }

    /// Question rows are keyed "loop:<loopId>".
    private var loopId: String { row.id.hasPrefix("loop:") ? String(row.id.dropFirst("loop:".count)) : row.id }
}

/// Ideas Thread isn't sure are yours to keep. Collapsed by default, nothing is deleted, and one
/// click on Keep moves an idea back into the list.
struct MaybeTray: View {
    let rows: [IdeaRow]
    let selectedId: String?
    let open: (IdeaRow) -> Void
    @State private var expanded = false
    @EnvironmentObject private var appState: AppState

    var body: some View {
        if !rows.isEmpty {
            DisclosureGroup(isExpanded: $expanded) {
                ForEach(rows) { r in
                    IdeaRowView(row: r, selected: r.ideaId == selectedId)
                        .contentShape(Rectangle())
                        .onTapGesture { open(r) }
                        .rowAccessibility(r, selected: r.ideaId == selectedId, showSnippet: appState.showSnippets) { open(r) }
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
