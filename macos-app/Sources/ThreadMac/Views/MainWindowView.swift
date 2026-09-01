import SwiftUI

/// The Full Window (spec §4): sidebar → list → reading pane. A calm, roomy place to browse many
/// ideas and read long evolution histories — distinct from the fast menu-bar panel. Shares
/// AppState so selection and capture status stay in sync with the panel.
struct MainWindowView: View {
    @EnvironmentObject var appState: AppState

    enum Tab: String, CaseIterable, Identifiable {
        case ideas = "Ideas", loops = "Open Loops", settings = "Settings"
        var id: String { rawValue }
        var icon: String {
            switch self {
            case .ideas: return "lightbulb"
            case .loops: return "circle.dashed"
            case .settings: return "gearshape"
            }
        }
    }

    @State private var tab: Tab = .ideas
    @State private var query = ""

    var body: some View {
        NavigationSplitView {
            List(Tab.allCases, selection: $tab) { t in
                Label(t.rawValue, systemImage: t.icon).tag(t)
            }
            .navigationSplitViewColumnWidth(min: 168, ideal: 190, max: 220)
            .safeAreaInset(edge: .bottom) {
                HStack(spacing: 6) {
                    Circle().fill(appState.isLocked ? Color.orange : Theme.accent).frame(width: 6, height: 6)
                    Text(appState.planLabel).font(.system(size: 11)).foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(12)
            }
        } content: {
            Group {
                switch tab {
                case .ideas: IdeaListColumn(query: $query)
                case .loops: LoopListColumn()
                case .settings: SettingsView().frame(maxWidth: 460).padding()
                }
            }
            .navigationSplitViewColumnWidth(min: 280, ideal: 340, max: 460)
        } detail: {
            ReadingPane()
        }
        .frame(minWidth: 900, minHeight: 560)
        .task { await appState.refresh() }
    }
}

private struct IdeaListColumn: View {
    @EnvironmentObject var appState: AppState
    @Binding var query: String

    private var rows: [AnyIdeaRow] {
        if query.isEmpty {
            return (appState.thinkingState?.currentIdeas ?? []).map(AnyIdeaRow.init)
        }
        return appState.searchResults.map(AnyIdeaRow.init)
    }

    var body: some View {
        List(rows, selection: Binding(
            get: { appState.selectedIdeaId },
            set: { id in if let id { Task { await appState.openIdea(id) } } }
        )) { row in
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(row.title).font(.system(size: 13, weight: .medium)).lineLimit(1)
                    Spacer()
                    StatePill(state: row.state)
                }
                Text(row.formulation).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
            }
            .padding(.vertical, 3)
            .tag(row.id)
        }
        .searchable(text: $query, placement: .toolbar, prompt: "Search ideas")
        .onChange(of: query) { _ in Task { await appState.search() } }
        .navigationTitle("Ideas")
    }
}

private struct LoopListColumn: View {
    @EnvironmentObject var appState: AppState
    var body: some View {
        let loops = (appState.thinkingState?.openLoops ?? []).filter { !$0.resolved }
        List(loops, selection: Binding(
            get: { appState.selectedIdeaId },
            set: { _ in }
        )) { loop in
            VStack(alignment: .leading, spacing: 3) {
                Text(loop.statement).font(.system(size: 12))
                Text(loop.ideaTitle).font(.system(size: 10)).foregroundStyle(.secondary)
            }
            .padding(.vertical, 3)
            .contentShape(Rectangle())
            .onTapGesture { Task { await appState.openIdea(loop.ideaId) } }
        }
        .overlay {
            if loops.isEmpty {
                ContentUnavailableView("Nothing unresolved", systemImage: "checkmark.circle")
            }
        }
        .navigationTitle("Open Loops")
    }
}

private struct ReadingPane: View {
    @EnvironmentObject var appState: AppState
    var body: some View {
        if appState.selectedIdeaId != nil {
            IdeaDetailView()
                .frame(maxWidth: 640)
                .frame(maxWidth: .infinity, alignment: .top)
        } else {
            ContentUnavailableView(
                "Select an idea",
                systemImage: "sidebar.right",
                description: Text("Its formulation, full evolution, and open loops appear here.")
            )
        }
    }
}

private struct AnyIdeaRow: Identifiable {
    let id: String
    let title: String
    let formulation: String
    let state: String
    init(_ s: IdeaSummary) { id = s.id; title = s.title; formulation = s.currentFormulation; state = s.state }
    init(_ s: SearchResult) { id = s.id; title = s.title; formulation = s.currentFormulation; state = s.state }
}
