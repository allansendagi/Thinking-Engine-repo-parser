import SwiftUI

struct MenuBarListView: View {
    @EnvironmentObject var appState: AppState
    @FocusState private var searchFocused: Bool

    /// The visible segment. Backed by AppState (see `ListTab`) so `thread://loops` and the
    /// Services menu can switch it, and so it survives the list⇄detail swap.
    private var tab: ListTab {
        get { appState.listTab }
        nonmutating set { appState.listTab = newValue }
    }
    private var tabBinding: Binding<ListTab> {
        Binding(get: { appState.listTab }, set: { appState.listTab = $0 })
    }

    /// Highlighted row. Backed by AppState so it survives the list⇄detail swap (see the mock's
    /// persistent `state.sel`): pick row 2, open it, come back — row 2 is still blue.
    private var selection: String? {
        get { appState.listSelection }
        nonmutating set { appState.listSelection = newValue }
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

    /// ideaId -> "ChatGPT" etc. Fallback for open loops whose own latestSource is absent
    /// (older backend payloads).
    private var ideaSourceLabel: [String: String] {
        var m: [String: String] = [:]
        for i in appState.thinkingState?.currentIdeas ?? [] {
            if let l = i.sourceLabel { m[i.id] = l }
        }
        return m
    }

    private var openLoops: [ThinkingStateResponse.OpenLoopEntry] {
        (appState.thinkingState?.openLoops ?? []).filter { !$0.resolved }
    }
    private var loopIdeaIDs: Set<String> { Set(openLoops.map(\.ideaId)) }

    // Row look, title cleanup, `metaLine`, date bucketing all live in IdeaRowKit.swift now,
    // shared with the full window so the two surfaces are one design.

    private func ideaRow(_ i: IdeaSummary) -> IdeaRow {
        let when = lastTouched[i.id] ?? ""
        let title = cleanIdeaTitle(i.title, fallback: i.currentFormulation)
        return IdeaRow(id: i.id, title: title,
                       snippet: rowSnippet(title: title, formulation: i.currentFormulation),
                       meta: metaLine(i.sourceLabel, when),
                       isLoop: false, ideaId: i.id, when: when,
                       status: rowStatus(state: i.state, hasOpenLoop: loopIdeaIDs.contains(i.id)))
    }
    private func loopRow(_ l: ThinkingStateResponse.OpenLoopEntry) -> IdeaRow {
        let when = l.createdAt ?? lastTouched[l.ideaId] ?? ""
        return IdeaRow(id: "loop:" + l.loopId, title: deNarrate(l.statement.trimmingCharacters(in: .whitespaces)),
                       snippet: nil, meta: metaLine(l.sourceLabel ?? ideaSourceLabel[l.ideaId], when),
                       isLoop: true, ideaId: l.ideaId, when: when)
    }

    private var groups: [IdeaRowGroup] {
        if searching {
            let rows = appState.searchResults.map { r -> IdeaRow in
                let title = cleanIdeaTitle(r.title, fallback: r.currentFormulation)
                return IdeaRow(id: r.id, title: title,
                               snippet: rowSnippet(title: title, formulation: r.currentFormulation),
                               meta: "", isLoop: false, ideaId: r.id, when: "")
            }
            return rows.isEmpty ? [] : [IdeaRowGroup(id: "r", label: "Results", rows: rows)]
        }
        let ideas = appState.thinkingState?.currentIdeas ?? []
        switch tab {
        case .loops:
            return openLoopGroups(openLoops, flatLabel: "Open loops",
                                  sourceLabelFor: { ideaSourceLabel[$0] },
                                  whenFor: { lastTouched[$0] })
        case .recent, .all:
            let loopIdeaIDs = Set(openLoops.map(\.ideaId))

            // Captures made on this Mac the backend hasn't confirmed yet — shown first, with the
            // on-device draft, so a capture appears the instant it's made.
            let pendingGroup: [IdeaRowGroup] = appState.pendingCaptures.isEmpty ? [] : [
                IdeaRowGroup(id: "pending", label: "Just captured", rows: appState.pendingCaptures.map { pc in
                    IdeaRow(
                        id: "pending:" + pc.id,
                        title: pc.draft?.title ?? "Reading this…",
                        snippet: pc.draft?.formulation,
                        meta: pc.status == .failed ? "Waiting for connection" : "Syncing…",
                        isLoop: false, ideaId: pc.id, when: ""
                    )
                })
            ]

            // All tab leads with a "Pinned" group (mock parity); those ideas are then held out
            // of the date buckets so they don't show twice.
            var pinnedGroup: [IdeaRowGroup] = []
            var pinnedIDs: Set<String> = []
            if tab == .all {
                let pinned = ideas.filter { appState.isPinned($0.id) }.map(ideaRow)
                if !pinned.isEmpty {
                    pinnedGroup = [IdeaRowGroup(id: "pinned", label: "Pinned", rows: pinned)]
                    pinnedIDs = Set(pinned.map(\.id))
                }
            }

            let items: [IdeaRow] = tab == .recent
                ? ideas.filter { !loopIdeaIDs.contains($0.id) }.map(ideaRow) + openLoops.map(loopRow)
                : ideas.filter { !pinnedIDs.contains($0.id) }.map(ideaRow)
            return pendingGroup + pinnedGroup + dateBucketedGroups(items)
        }
    }

    private var flatIDs: [String] { groups.flatMap { $0.rows.map(\.id) } }

    var body: some View {
        VStack(spacing: 0) {
            chrome
            if !searching, tab == .recent, let s = appState.resumeSuggestion {
                ResumeBar(
                    suggestion: s,
                    onResume: {
                        appState.snoozeResume(s.ideaId)
                        Task {
                            await appState.openIdea(s.ideaId)
                            await appState.continueThinking(sendTo: nil)
                        }
                    },
                    onDismiss: { withAnimation(.easeOut(duration: 0.16)) { appState.snoozeResume(s.ideaId) } }
                )
            }
            if groups.isEmpty {
                EmptyState(onboard: !appState.onboardingDismissed && tab != .loops,
                           dismiss: { appState.dismissOnboarding() }, loops: tab == .loops)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                scroller
            }
        }
        .onAppear { searchFocused = true; selectFirstIfNeeded() }
        .onChange(of: flatIDs) { _ in selectFirstIfNeeded() }
    }

    /// The design shows a row already highlighted blue at rest, so pre-select the first row --
    /// EXCEPT on the Open loops tab, where an unresolved question isn't a thing you're "on" and a
    /// default blue fill reads as noise. There, start with nothing selected.
    private func selectFirstIfNeeded() {
        guard !searching else { return }
        if tab == .loops {
            if let s = selection, !flatIDs.contains(s) { selection = nil }
            return
        }
        if selection == nil || !(flatIDs.contains(selection!)) {
            selection = flatIDs.first
        }
    }

    // MARK: chrome — search + segmented

    private var chrome: some View {
        VStack(spacing: 9) {
            HStack(spacing: 6) {
                Glyph(kind: .search, size: 12).foregroundStyle(Theme.ink(0.4))
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
                Segmented(selection: tabBinding)
                    .onChange(of: tab) { newTab in selection = newTab == .loops ? nil : flatIDs.first }
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
                                IdeaRowView(row: r, selected: selection == r.id)
                                    .id(r.id)
                                    .contentShape(Rectangle())
                                    .onTapGesture { selection = r.id; open(r.id) }
                                    .contextMenu {
                                        if !r.isLoop {
                                            Button(appState.isPinned(r.ideaId) ? "Unpin" : "Pin to top") {
                                                appState.togglePin(r.ideaId)
                                            }
                                        }
                                    }
                            }
                        } header: {
                            IdeaRowSectionHeader(label: g.label)
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
        // A "Just captured" row has no idea to open yet — it becomes a real row on sync.
        if id.hasPrefix("pending:") { return }
        if id.hasPrefix("loop:") {
            let lid = String(id.dropFirst(5))
            if let l = openLoops.first(where: { $0.loopId == lid }) { Task { await appState.openIdea(l.ideaId) } }
        } else {
            Task { await appState.openIdea(id) }
        }
    }

}

// MARK: - Custom segmented (exact mock styling)

private struct Segmented: View {
    @Binding var selection: ListTab
    var body: some View {
        HStack(spacing: 1.5) {
            ForEach(ListTab.allCases) { t in
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
