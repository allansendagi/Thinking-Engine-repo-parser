import SwiftUI

/// The optional Full Window (spec §4): a narrow sidebar + a roomy content area for browsing many
/// ideas or reviewing long histories. Not the primary surface -- the menu-bar panel is. Reuses
/// AppState, so selection and capture status stay consistent with the panel.
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

    var body: some View {
        NavigationSplitView {
            List(Tab.allCases, selection: $tab) { t in
                Label(t.rawValue, systemImage: t.icon).tag(t)
            }
            .navigationSplitViewColumnWidth(min: 160, ideal: 180, max: 220)
        } detail: {
            Group {
                switch tab {
                case .ideas: IdeasPane()
                case .loops: LoopsPane()
                case .settings: SettingsView().frame(maxWidth: 420)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .frame(minWidth: 720, minHeight: 480)
        .task { await appState.refresh() }
    }
}

private struct IdeasPane: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        let ideas = appState.searchResults.isEmpty && appState.searchQuery.isEmpty
            ? (appState.thinkingState?.currentIdeas.map { AnyIdeaRow($0) } ?? [])
            : appState.searchResults.map { AnyIdeaRow($0) }

        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search ideas…", text: $appState.searchQuery)
                    .textFieldStyle(.plain)
                    .onChange(of: appState.searchQuery) { _ in Task { await appState.search() } }
            }
            .padding(12)
            Divider()

            if let id = appState.selectedIdeaId, appState.selectedTrace != nil {
                HStack {
                    Button { appState.closeIdea() } label: { Label("All ideas", systemImage: "chevron.left") }
                        .buttonStyle(.plain).padding(10)
                    Spacer()
                }
                Divider()
                IdeaDetailView().id(id)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(ideas) { row in
                            Button { Task { await appState.openIdea(row.id) } } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(row.title).font(.system(size: 14, weight: .medium))
                                    Text(row.formulation).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(2)
                                }
                                .threadCard()
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(14)
                }
            }
        }
    }
}

private struct LoopsPane: View {
    @EnvironmentObject var appState: AppState
    var body: some View {
        let loops = (appState.thinkingState?.openLoops ?? []).filter { !$0.resolved }
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                if loops.isEmpty {
                    Text("Nothing unresolved.").foregroundStyle(.secondary).padding(14)
                }
                ForEach(loops) { loop in
                    Button { Task { await appState.openIdea(loop.ideaId) } } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(loop.statement).font(.system(size: 13))
                            Text(loop.ideaTitle).font(.system(size: 11)).foregroundStyle(.secondary)
                        }
                        .threadCard()
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(14)
        }
    }
}

/// Erases IdeaSummary / SearchResult to a common row shape for the list.
private struct AnyIdeaRow: Identifiable {
    let id: String
    let title: String
    let formulation: String
    init(_ s: IdeaSummary) { id = s.id; title = s.title; formulation = s.currentFormulation }
    init(_ s: SearchResult) { id = s.id; title = s.title; formulation = s.currentFormulation }
}
