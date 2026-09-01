import SwiftUI

struct MenuBarListView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Search your ideas…", text: $appState.searchQuery)
                .textFieldStyle(.roundedBorder)
                .padding(.horizontal, 10)
                .onChange(of: appState.searchQuery) { _ in Task { await appState.search() } }

            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if !appState.searchQuery.trimmingCharacters(in: .whitespaces).isEmpty {
                        searchResultsSection
                    } else {
                        openLoopsSection
                        ideasSection
                    }
                }
                .padding(10)
            }
        }
        .padding(.top, 6)
    }

    private var searchResultsSection: some View {
        Group {
            if appState.searchResults.isEmpty {
                Text("No matches.").font(.caption).foregroundColor(.secondary)
            } else {
                ForEach(appState.searchResults) { result in
                    ideaRow(id: result.id, title: result.title, state: result.state)
                }
            }
        }
    }

    private var openLoopsSection: some View {
        Group {
            let loops = (appState.thinkingState?.openLoops ?? []).filter { !$0.resolved }
            Text("OPEN LOOPS").font(.caption2).foregroundColor(.secondary)
            if loops.isEmpty {
                Text("Nothing open.").font(.caption).foregroundColor(.secondary)
            } else {
                ForEach(loops) { loop in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(loop.statement).font(.callout)
                        Text(loop.ideaTitle).font(.caption2).foregroundColor(.secondary)
                    }
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.gray.opacity(0.08))
                    .cornerRadius(6)
                    .onTapGesture { Task { await appState.openIdea(loop.ideaId) } }
                }
            }
        }
    }

    private var ideasSection: some View {
        Group {
            Text("CURRENT IDEAS").font(.caption2).foregroundColor(.secondary).padding(.top, 6)
            if appState.isLoading {
                ProgressView()
            } else if (appState.thinkingState?.currentIdeas ?? []).isEmpty {
                Text("Nothing captured yet.").font(.caption).foregroundColor(.secondary)
            } else {
                ForEach(appState.thinkingState?.currentIdeas ?? []) { idea in
                    ideaRow(id: idea.id, title: idea.title, state: idea.state)
                }
            }
        }
    }

    private func ideaRow(id: String, title: String, state: String) -> some View {
        HStack {
            Text(title).font(.callout)
            Spacer()
            Text(state).font(.caption2).foregroundColor(.secondary)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.gray.opacity(0.08))
        .cornerRadius(6)
        .contentShape(Rectangle())
        .onTapGesture { Task { await appState.openIdea(id) } }
    }
}
