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

    private var searching: Bool { !appState.searchQuery.trimmingCharacters(in: .whitespaces).isEmpty }

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

    struct Row: Identifiable {
        let id: String
        let title: String
        let snippet: String?
        let meta: String
        let isLoop: Bool
        let ideaId: String
        let when: String
    }
    struct Group: Identifiable { let id: String; let label: String; let rows: [Row] }

    private func ideaRow(_ i: IdeaSummary) -> Row {
        Row(id: i.id, title: clean(i.title, i.currentFormulation), snippet: i.currentFormulation,
            meta: Theme.ago(lastTouched[i.id] ?? ""), isLoop: false, ideaId: i.id,
            when: lastTouched[i.id] ?? "")
    }
    private func loopRow(_ l: ThinkingStateResponse.OpenLoopEntry) -> Row {
        Row(id: "loop:" + l.loopId, title: l.statement, snippet: nil, meta: "Open loop",
            isLoop: true, ideaId: l.ideaId, when: "")
    }

    private var groups: [Group] {
        if searching {
            let rows = appState.searchResults.map {
                Row(id: $0.id, title: clean($0.title, $0.currentFormulation), snippet: $0.currentFormulation,
                    meta: "", isLoop: false, ideaId: $0.id, when: "")
            }
            return rows.isEmpty ? [] : [Group(id: "r", label: "Results", rows: rows)]
        }
        let ideas = appState.thinkingState?.currentIdeas ?? []
        switch tab {
        case .loops:
            return openLoops.isEmpty ? [] : [Group(id: "l", label: "Open loops", rows: openLoops.map(loopRow))]
        case .recent, .all:
            let loopIdeaIDs = Set(openLoops.map(\.ideaId))
            let items: [Row] = tab == .recent
                ? ideas.filter { !loopIdeaIDs.contains($0.id) }.map(ideaRow) + openLoops.map(loopRow)
                : ideas.map(ideaRow)
            var buckets: [Int: (String, [Row])] = [:]
            for r in items {
                let b: (order: Int, label: String) = r.when.isEmpty ? (4, "Earlier") : Theme.bucket(r.when)
                buckets[b.order, default: (b.label, [])].1.append(r)
            }
            return buckets.keys.sorted().map { k in
                let (label, rows) = buckets[k]!
                return Group(id: "b\(k)", label: label, rows: rows.sorted { $0.when > $1.when })
            }
        }
    }

    private var flatIDs: [String] { groups.flatMap { $0.rows.map(\.id) } }

    var body: some View {
        VStack(spacing: 0) {
            chrome
            if groups.isEmpty {
                EmptyState(onboard: !appState.onboardingDismissed && tab != .loops,
                           dismiss: { appState.dismissOnboarding() }, loops: tab == .loops)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                scroller
            }
        }
        .onAppear { searchFocused = true }
    }

    // MARK: chrome — search + segmented

    private var chrome: some View {
        VStack(spacing: 9) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 11)).foregroundStyle(Theme.ink(0.4))
                TextField("Search", text: $appState.searchQuery)
                    .textFieldStyle(.plain).font(.system(size: 12.5))
                    .foregroundStyle(Theme.ink(0.85))
                    .focused($searchFocused)
                    .onChange(of: appState.searchQuery) { _ in Task { await appState.search() } }
                    .onKeyPress(.downArrow) {
                        if let f = flatIDs.first { selection = f; searchFocused = false }; return .handled
                    }
                if searching {
                    Button { appState.searchQuery = "" } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain).foregroundStyle(Theme.ink(0.3))
                }
            }
            .frame(height: 26).padding(.horizontal, 8)
            .background(Theme.fieldFill, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.ink(0.09), lineWidth: 0.5))

            if !searching {
                Segmented(selection: $tab)
                    .onChange(of: tab) { _ in selection = nil }
            }
        }
        .padding(.horizontal, 12).padding(.bottom, 10)
    }

    // MARK: scroller — grouped, sticky headers, self-drawn selection

    private var scroller: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                    ForEach(groups) { g in
                        Section {
                            ForEach(g.rows) { r in
                                RowView(row: r, selected: selection == r.id)
                                    .id(r.id)
                                    .contentShape(Rectangle())
                                    .onTapGesture { selection = r.id; open(r.id) }
                            }
                        } header: {
                            Text(g.label)
                                .font(.system(size: 12, weight: .semibold)).kerning(-0.12)
                                .foregroundStyle(Theme.ink(0.85))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 5)
                                .background(Theme.stickyTint.background(.ultraThinMaterial))
                        }
                    }
                }
                .padding(.bottom, 8)
            }
            .scrollContentBackground(.hidden)
            .focusable()
            .onKeyPress(.upArrow) { move(-1, proxy); return .handled }
            .onKeyPress(.downArrow) { move(1, proxy); return .handled }
            .onKeyPress(.return) { open(selection); return .handled }
        }
    }

    private func move(_ d: Int, _ proxy: ScrollViewProxy) {
        let ids = flatIDs
        guard !ids.isEmpty else { return }
        let cur = selection.flatMap { ids.firstIndex(of: $0) } ?? -1
        let next = max(0, min(ids.count - 1, cur + d))
        selection = ids[next]
        withAnimation(.easeOut(duration: 0.12)) { proxy.scrollTo(ids[next], anchor: .center) }
    }

    private func open(_ id: String?) {
        guard let id else { return }
        if id.hasPrefix("loop:") {
            let lid = String(id.dropFirst(5))
            if let l = openLoops.first(where: { $0.loopId == lid }) { Task { await appState.openIdea(l.ideaId) } }
        } else {
            Task { await appState.openIdea(id) }
        }
    }

    // MARK: title cleanup

    private func clean(_ title: String, _ fallback: String) -> String {
        let t = deNarrate(title.trimmingCharacters(in: .whitespaces))
        if t.isEmpty || t.hasSuffix("…") || t.hasSuffix("...") {
            let c = fallback.split(whereSeparator: { ".?!".contains($0) }).first.map(String.init) ?? fallback
            return deNarrate(c.trimmingCharacters(in: .whitespaces))
        }
        return t
    }
    private func deNarrate(_ s: String) -> String {
        let ps = ["The user is asking why ", "The user is asking whether ", "The user is asking what ",
                  "The user is asking how ", "The user is asking for ", "The user is asking ",
                  "The user is questioning ", "The user is seeking ", "The user is proposing ",
                  "The user is claiming ", "The user decides to ", "The user claims ", "The user wants to ",
                  "The human is asking why ", "The human is asking whether ", "The human is asking ",
                  "The human is questioning ", "The assistant is ", "The user is ", "The human is "]
        for p in ps where s.lowercased().hasPrefix(p.lowercased()) {
            let r = String(s.dropFirst(p.count)); return r.prefix(1).capitalized + r.dropFirst()
        }
        return s
    }
}

// MARK: - Custom segmented (exact mock styling)

private struct Segmented: View {
    @Binding var selection: MenuBarListView.Tab
    var body: some View {
        HStack(spacing: 1.5) {
            ForEach(MenuBarListView.Tab.allCases) { t in
                let on = selection == t
                Text(t.rawValue)
                    .font(.system(size: 12, weight: on ? .semibold : .medium)).kerning(-0.06)
                    .foregroundStyle(Theme.ink(on ? 0.85 : 0.55))
                    .frame(maxWidth: .infinity).frame(height: 21)
                    .background(
                        RoundedRectangle(cornerRadius: 5.5)
                            .fill(Color.white)
                            .shadow(color: .black.opacity(0.16), radius: 1.25, y: 0.5)
                            .overlay(RoundedRectangle(cornerRadius: 5.5).stroke(Theme.ink(0.1), lineWidth: 0.5))
                            .opacity(on ? 1 : 0)
                    )
                    .contentShape(Rectangle())
                    .onTapGesture { selection = t }
            }
        }
        .padding(1.5)
        .background(Theme.ink(0.06), in: RoundedRectangle(cornerRadius: 7))
    }
}

// MARK: - Row (exact mock: grid 16/1fr, accent fill when selected)

private struct RowView: View {
    let row: MenuBarListView.Row
    let selected: Bool
    @State private var hover = false

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Glyph(kind: row.isLoop ? .loop : .idea, size: 14)
                .foregroundStyle(selected ? Theme.onAccent(0.9) : Theme.ink(0.42))
                .frame(width: 16).padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(.system(size: 12.5, weight: .medium)).kerning(-0.08)
                    .lineSpacing(1.5).lineLimit(2)
                    .foregroundStyle(selected ? Color.white : Theme.ink(0.87))
                if let s = row.snippet, !s.isEmpty {
                    Text(s).font(.system(size: 11.5)).lineSpacing(1).lineLimit(2)
                        .foregroundStyle(selected ? Theme.onAccent(0.82) : Theme.ink(0.5))
                }
                if !row.meta.isEmpty {
                    Text(row.meta).font(.system(size: 11))
                        .foregroundStyle(selected ? Theme.onAccent(0.72) : Theme.ink(0.36))
                        .padding(.top, 1)
                }
            }
        }
        .padding(.init(top: 8, leading: 10, bottom: 9, trailing: 10))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 7)
                .fill(selected ? Theme.accent : (hover ? Theme.hoverFill : Color.clear))
        )
        .padding(.horizontal, 8).padding(.bottom, 1)
        .onHover { hover = $0 }
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
                .font(.system(size: 28, weight: .light)).foregroundStyle(Theme.accent)
            Text(loops ? "No open loops" : "Nothing captured yet")
                .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Theme.ink(0.85))
            if !loops {
                Text("Talk to ChatGPT, Claude, or Gemini and your first idea shows up here.")
                    .font(.system(size: 11.5)).foregroundStyle(Theme.ink(0.5))
                    .multilineTextAlignment(.center).frame(maxWidth: 250)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if onboard { OnboardingCard(dismiss: dismiss).frame(maxWidth: 300).padding(.top, 4) }
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
                Text("Finish setup").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.ink(0.8))
                Spacer()
                Button(action: dismiss) { Image(systemName: "xmark") }
                    .buttonStyle(.plain).font(.system(size: 9)).foregroundStyle(Theme.ink(0.3))
            }
            step(1, "Install the browser extension")
            step(2, "Talk to ChatGPT, Claude, Gemini or Cursor")
            step(3, "Press ⌘⇧T to recall anything")
        }
        .padding(12)
        .background(Color.white.opacity(0.7), in: RoundedRectangle(cornerRadius: Theme.cardCorner))
        .overlay(RoundedRectangle(cornerRadius: Theme.cardCorner).stroke(Theme.cardStroke, lineWidth: 0.5))
    }
    private func step(_ n: Int, _ t: String) -> some View {
        HStack(spacing: 8) {
            Text("\(n)").font(.system(size: 9, weight: .bold, design: .rounded)).foregroundStyle(Theme.accent)
                .frame(width: 14, height: 14).background(Theme.accent.opacity(0.15), in: Circle())
            Text(t).font(.system(size: 11)).foregroundStyle(Theme.ink(0.5))
        }
    }
}
