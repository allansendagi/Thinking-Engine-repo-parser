import SwiftUI

struct MenuBarListView: View {
    @EnvironmentObject var appState: AppState
    @FocusState private var searchFocused: Bool
    @State private var selection: String?
    @State private var tab: Tab = .recent

    enum Tab: String, CaseIterable, Identifiable {
        case recent = "Recent", loops = "Open loops", all = "All"
        var id: String { rawValue }
    }

    private var searching: Bool {
        !appState.searchQuery.trimmingCharacters(in: .whitespaces).isEmpty
    }

    // ideaId -> most recent change timestamp
    private var lastTouched: [String: String] {
        var m: [String: String] = [:]
        for c in appState.thinkingState?.recentChanges ?? [] {
            if let e = m[c.ideaId], e >= c.createdAt { continue }
            m[c.ideaId] = c.createdAt
        }
        return m
    }

    private var openLoops: [ThinkingStateResponse.OpenLoopEntry] {
        (appState.thinkingState?.openLoops ?? []).filter { !$0.resolved }
    }

    // MARK: rows model

    struct Row: Identifiable {
        let id: String
        let title: String
        let snippet: String?
        let meta: String
        let isLoop: Bool
        let ideaId: String
        let when: String
    }

    struct Group: Identifiable {
        let id: String
        let label: String
        let rows: [Row]
    }

    private func ideaRow(_ i: IdeaSummary) -> Row {
        let when = lastTouched[i.id] ?? i.currentFormulation
        return Row(
            id: i.id,
            title: displayTitle(i.title, fallback: i.currentFormulation),
            snippet: i.currentFormulation,
            meta: Theme.ago(lastTouched[i.id] ?? ""),
            isLoop: false, ideaId: i.id,
            when: lastTouched[i.id] ?? ""
        )
    }

    private func loopRow(_ l: ThinkingStateResponse.OpenLoopEntry) -> Row {
        Row(id: "loop:" + l.loopId, title: l.statement, snippet: nil,
            meta: "Open loop", isLoop: true, ideaId: l.ideaId, when: "")
    }

    private var groups: [Group] {
        if searching {
            let rows = appState.searchResults.map {
                Row(id: $0.id, title: displayTitle($0.title, fallback: $0.currentFormulation),
                    snippet: $0.currentFormulation, meta: "", isLoop: false, ideaId: $0.id, when: "")
            }
            return rows.isEmpty ? [] : [Group(id: "results", label: "Results", rows: rows)]
        }

        let ideas = appState.thinkingState?.currentIdeas ?? []
        switch tab {
        case .loops:
            return openLoops.isEmpty ? [] : [Group(id: "loops", label: "Open loops", rows: openLoops.map(loopRow))]
        case .recent, .all:
            let loopIdeaIDs = Set(openLoops.map(\.ideaId))
            let items: [Row] =
                tab == .recent
                ? (ideas.filter { !loopIdeaIDs.contains($0.id) }.map(ideaRow) + openLoops.map(loopRow))
                : ideas.map(ideaRow)
            // bucket by time
            var buckets: [Int: (String, [Row])] = [:]
            for r in items {
                let b: (order: Int, label: String) = r.when.isEmpty ? (4, "Earlier") : Theme.bucket(r.when)
                buckets[b.order, default: (b.label, [])].1.append(r)
            }
            return buckets.keys.sorted().map { k in
                let (label, rows) = buckets[k]!
                return Group(id: "b\(k)", label: label,
                             rows: rows.sorted { $0.when > $1.when })
            }
        }
    }

    // MARK: body

    var body: some View {
        VStack(spacing: 0) {
            chrome
            list
        }
        .onAppear { searchFocused = true }
    }

    private var chrome: some View {
        VStack(spacing: 9) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 11)).foregroundStyle(Theme.ink(0.4))
                TextField("Search", text: $appState.searchQuery)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12.5))
                    .focused($searchFocused)
                    .onChange(of: appState.searchQuery) { _ in Task { await appState.search() } }
                    .onKeyPress(.downArrow) {
                        if let first = groups.first?.rows.first { selection = first.id; searchFocused = false }
                        return .handled
                    }
                if searching {
                    Button { appState.searchQuery = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                    }.buttonStyle(.plain).foregroundStyle(Theme.ink(0.3))
                }
            }
            .frame(height: 26)
            .padding(.horizontal, 8)
            .background(Theme.fieldFill, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.ink(0.09), lineWidth: 0.5))

            if !searching {
                Picker("", selection: $tab) {
                    ForEach(Tab.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .controlSize(.small)
                .onChange(of: tab) { _ in selection = nil }
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 10)
    }

    @ViewBuilder private var list: some View {
        if groups.isEmpty {
            EmptyState(
                onboard: !appState.onboardingDismissed && tab != .loops,
                dismiss: { appState.dismissOnboarding() },
                loops: tab == .loops
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            List(selection: $selection) {
                ForEach(groups) { g in
                    Section {
                        ForEach(g.rows) { r in
                            RowView(row: r).tag(r.id)
                        }
                    } header: {
                        Text(g.label)
                            .font(.system(size: 12, weight: .semibold)).kerning(-0.1)
                            .foregroundStyle(Theme.ink(0.85))
                    }
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 1)
            .onChange(of: selection) { open($0) }
            .onKeyPress(.return) { open(selection); return .handled }
        }
    }

    private func open(_ id: String?) {
        guard let id else { return }
        if id.hasPrefix("loop:") {
            let lid = String(id.dropFirst(5))
            if let l = openLoops.first(where: { $0.loopId == lid }) {
                Task { await appState.openIdea(l.ideaId) }
            }
        } else {
            Task { await appState.openIdea(id) }
        }
    }

    // MARK: title cleanup

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

// MARK: - Row

private struct RowView: View {
    let row: MenuBarListView.Row

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: row.isLoop ? "questionmark.circle" : "lightbulb")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .frame(width: 16)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(.system(size: 12.5, weight: .medium)).kerning(-0.1)
                    .lineLimit(2)
                if let snip = row.snippet, !snip.isEmpty {
                    Text(snip)
                        .font(.system(size: 11.5)).foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                if !row.meta.isEmpty {
                    Text(row.meta).font(.system(size: 11)).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 4)
        .listRowSeparator(.hidden)
        .contentShape(Rectangle())
    }
}

// MARK: - Empty / onboarding

private struct EmptyState: View {
    let onboard: Bool
    let dismiss: () -> Void
    let loops: Bool

    var body: some View {
        VStack(spacing: 13) {
            Spacer()
            Image(systemName: loops ? "checkmark.circle" : "sparkles")
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(Theme.accent.gradient)
            Text(loops ? "No open loops" : "Nothing captured yet")
                .font(.system(size: 13.5, weight: .semibold))
            if !loops {
                Text("Talk to ChatGPT, Claude, or Gemini and your first idea shows up here.")
                    .font(.system(size: 11.5)).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center).frame(maxWidth: 250)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if onboard {
                OnboardingCard(dismiss: dismiss).frame(maxWidth: 300).padding(.top, 4)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity).padding(20)
    }
}

private struct OnboardingCard: View {
    let dismiss: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Finish setup").font(.system(size: 11, weight: .semibold))
                Spacer()
                Button(action: dismiss) { Image(systemName: "xmark") }
                    .buttonStyle(.plain).font(.system(size: 9)).foregroundStyle(.tertiary)
            }
            step(1, "Install the browser extension")
            step(2, "Talk to ChatGPT, Claude, Gemini or Cursor")
            step(3, "Press ⌘⇧T to recall anything")
        }
        .padding(12)
        .background(Theme.cardFill, in: RoundedRectangle(cornerRadius: Theme.cardCorner))
        .overlay(RoundedRectangle(cornerRadius: Theme.cardCorner).stroke(Theme.cardStroke, lineWidth: 0.5))
    }

    private func step(_ n: Int, _ t: String) -> some View {
        HStack(spacing: 8) {
            Text("\(n)").font(.system(size: 9, weight: .bold, design: .rounded))
                .foregroundStyle(Theme.accent)
                .frame(width: 14, height: 14)
                .background(Theme.accent.opacity(0.15), in: Circle())
            Text(t).font(.system(size: 11)).foregroundStyle(.secondary)
        }
    }
}
