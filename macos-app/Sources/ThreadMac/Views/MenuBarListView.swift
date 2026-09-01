import SwiftUI

struct MenuBarListView: View {
    @EnvironmentObject var appState: AppState
    @FocusState private var searchFocused: Bool

    private var searching: Bool {
        !appState.searchQuery.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// ideaId -> most recent change timestamp, so the list can show "2h" / "3d".
    private var lastChange: [String: String] {
        var map: [String: String] = [:]
        for c in appState.thinkingState?.recentChanges ?? [] {
            if let existing = map[c.ideaId], existing >= c.createdAt { continue }
            map[c.ideaId] = c.createdAt
        }
        return map
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
                } else {
                    Text("⌘⇧T").font(.system(size: 10, design: .monospaced)).foregroundStyle(.tertiary)
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
                        currentIdeas
                        openLoops
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
                IdeaCard(title: displayTitle(r.title, fallback: r.currentFormulation),
                         formulation: r.currentFormulation, state: r.state,
                         when: lastChange[r.id]) {
                    Task { await appState.openIdea(r.id) }
                }
            }
        }
    }

    @ViewBuilder private var currentIdeas: some View {
        let loopIdeaIds = Set((appState.thinkingState?.openLoops ?? []).filter { !$0.resolved }.map(\.ideaId))
        let ideas = (appState.thinkingState?.currentIdeas ?? []).filter { !loopIdeaIds.contains($0.id) }

        Text("Recent ideas").sectionHeader()
        if appState.isLoading && ideas.isEmpty {
            ProgressView().controlSize(.small).padding(.vertical, 4)
        } else if ideas.isEmpty {
            emptyLine("Nothing captured yet. Talk to ChatGPT, Claude, or Gemini and it shows up here.")
        } else {
            ForEach(ideas) { idea in
                IdeaCard(title: displayTitle(idea.title, fallback: idea.currentFormulation),
                         formulation: idea.currentFormulation, state: idea.state,
                         when: lastChange[idea.id]) {
                    Task { await appState.openIdea(idea.id) }
                }
            }
        }
    }

    @ViewBuilder private var openLoops: some View {
        let loops = (appState.thinkingState?.openLoops ?? []).filter { !$0.resolved }
        if !loops.isEmpty {
            Text("Open loops").sectionHeader()
            ForEach(loops) { loop in
                Button(action: { Task { await appState.openIdea(loop.ideaId) } }) {
                    HStack(alignment: .top, spacing: 8) {
                        Text("•").foregroundStyle(Theme.accent)
                        Text(loop.statement).font(.system(size: 12)).foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func emptyLine(_ s: String) -> some View {
        Text(s).font(.system(size: 12)).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Clean up a backend-generated title. The extraction prompt currently produces narration
    /// ("The user is asking why…") rather than declarative idea names -- the real fix is in the
    /// prompt (src/extraction); this makes the current output presentable.
    private func displayTitle(_ title: String, fallback: String) -> String {
        let t = deNarrate(title.trimmingCharacters(in: .whitespaces))
        if t.isEmpty || t.hasSuffix("…") || t.hasSuffix("...") {
            let clause = fallback.split(whereSeparator: { ".?!".contains($0) }).first.map(String.init) ?? fallback
            return deNarrate(clause.trimmingCharacters(in: .whitespaces))
        }
        return t
    }

    private func deNarrate(_ s: String) -> String {
        let prefixes = [
            "The user is asking why ", "The user is asking whether ", "The user is asking what ",
            "The user is asking how ", "The user is asking for ", "The user is asking ",
            "The user is questioning ", "The user is seeking ", "The user is proposing ",
            "The user is claiming ", "The user decides to ", "The user claims ", "The user wants to ",
            "The human is asking why ", "The human is asking whether ", "The human is asking ",
            "The human is questioning ", "The assistant is ", "The user is ", "The human is ",
        ]
        for p in prefixes where s.lowercased().hasPrefix(p.lowercased()) {
            let rest = String(s.dropFirst(p.count))
            return rest.prefix(1).capitalized + rest.dropFirst()
        }
        return s
    }
}

private struct IdeaCard: View {
    let title: String
    let formulation: String
    let state: String
    let when: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(.primary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let when, !when.isEmpty {
                        Text(Theme.relative(when)).font(.system(size: 10)).foregroundStyle(.tertiary)
                    }
                    StatePill(state: state)
                }
                Text(formulation).font(.system(size: 11)).foregroundStyle(.secondary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .threadCard()
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
