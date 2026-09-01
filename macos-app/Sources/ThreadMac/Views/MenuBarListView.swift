import SwiftUI

struct MenuBarListView: View {
    @EnvironmentObject var appState: AppState
    @FocusState private var searchFocused: Bool

    private var searching: Bool {
        !appState.searchQuery.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary).font(.system(size: 12))
                TextField("Where was I with…", text: $appState.searchQuery)
                    .textFieldStyle(.plain)
                    .focused($searchFocused)
                    .onChange(of: appState.searchQuery) { _ in Task { await appState.search() } }
                if searching {
                    Button(action: { appState.searchQuery = "" }) { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain).foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if searching {
                        results
                    } else {
                        openLoops
                        currentIdeas
                    }
                }
                .padding(14)
            }
        }
        .onAppear { searchFocused = true }
    }

    // MARK: sections

    @ViewBuilder private var results: some View {
        if appState.searchResults.isEmpty {
            emptyLine("No matching ideas.")
        } else {
            ForEach(appState.searchResults) { r in
                IdeaCard(title: displayTitle(r.title, fallback: r.currentFormulation), state: r.state) {
                    Task { await appState.openIdea(r.id) }
                }
            }
        }
    }

    @ViewBuilder private var openLoops: some View {
        let loops = (appState.thinkingState?.openLoops ?? []).filter { !$0.resolved }
        Text("Open loops").sectionHeader()
        if loops.isEmpty {
            emptyLine("Nothing unresolved.")
        } else {
            ForEach(loops) { loop in
                LoopCard(question: loop.statement, idea: ideaSubtitle(loop.ideaTitle, question: loop.statement)) {
                    Task { await appState.openIdea(loop.ideaId) }
                }
            }
        }
    }

    @ViewBuilder private var currentIdeas: some View {
        // Ideas already surfaced as an open loop aren't repeated here.
        let loopIdeaIds = Set((appState.thinkingState?.openLoops ?? []).filter { !$0.resolved }.map(\.ideaId))
        let ideas = (appState.thinkingState?.currentIdeas ?? []).filter { !loopIdeaIds.contains($0.id) }

        Text("Recent ideas").sectionHeader()
        if appState.isLoading && ideas.isEmpty {
            ProgressView().controlSize(.small).padding(.vertical, 4)
        } else if ideas.isEmpty {
            emptyLine("Nothing captured yet. Talk to ChatGPT, Claude, or Gemini and it shows up here.")
        } else {
            ForEach(ideas) { idea in
                IdeaCard(title: displayTitle(idea.title, fallback: idea.currentFormulation), state: idea.state) {
                    Task { await appState.openIdea(idea.id) }
                }
            }
        }
    }

    private func emptyLine(_ s: String) -> some View {
        Text(s).font(.system(size: 12)).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Backend titles are often a truncated sentence ending in "…". Prefer a clean fallback.
    private func displayTitle(_ title: String, fallback: String) -> String {
        let t = title.trimmingCharacters(in: .whitespaces)
        if t.isEmpty || t.hasSuffix("…") || t.hasSuffix("...") {
            let clause = fallback.split(whereSeparator: { ".?!".contains($0) }).first.map(String.init) ?? fallback
            return clause.trimmingCharacters(in: .whitespaces)
        }
        return t
    }

    /// The idea a loop belongs to, shown small under the question -- but only when it actually
    /// adds information (not a truncated stub, not just the question restated).
    private func ideaSubtitle(_ ideaTitle: String, question: String) -> String? {
        let t = ideaTitle.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty, !t.hasSuffix("…"), !t.hasSuffix("...") else { return nil }
        let q = question.lowercased()
        if q.hasPrefix(t.lowercased()) || t.lowercased().hasPrefix(String(q.prefix(24))) { return nil }
        return t
    }
}

private struct IdeaCard: View {
    let title: String
    let state: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 8) {
                Text(title).font(.system(size: 13)).foregroundStyle(.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                StatePill(state: state)
            }
            .threadCard()
        }
        .buttonStyle(.plain)
    }
}

private struct LoopCard: View {
    let question: String
    let idea: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 0) {
                Rectangle().fill(Theme.accent).frame(width: 2)
                VStack(alignment: .leading, spacing: 3) {
                    Text(question).font(.system(size: 13)).foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let idea {
                        Text(idea).font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                }
                .padding(.leading, 9)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 9)
            .padding(.trailing, 10)
            .background(Theme.cardFill)
            .clipShape(RoundedRectangle(cornerRadius: Theme.cardCorner))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct StatePill: View {
    let state: String
    var body: some View {
        Text(state)
            .font(.system(size: 9, weight: .medium))
            .textCase(.uppercase)
            .kerning(0.4)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(Color(nsColor: .quaternaryLabelColor).opacity(0.5))
            .clipShape(Capsule())
    }
}
