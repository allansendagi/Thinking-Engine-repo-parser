import SwiftUI

/// The full window (spec §4): sidebar → list → reading pane. Same design vocabulary as the
/// menu-bar panel -- shared rows (IdeaRowKit), the same IdeaDetailView, the same light frosted
/// surface -- just with room to browse many ideas and read long histories. Freely resizable and
/// zoomable; the panel is the fast path, this is the calm one.
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
            sidebar
                .navigationSplitViewColumnWidth(min: 190, ideal: 208, max: 240)
        } content: {
            Group {
                switch tab {
                case .ideas: IdeaListColumn()
                case .loops: LoopListColumn()
                case .settings:
                    ScrollView { SettingsView().frame(maxWidth: 460).padding(24) }
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                }
            }
            .navigationSplitViewColumnWidth(min: 320, ideal: 384, max: 560)
            .background(Theme.panelTint.opacity(0.55))
        } detail: {
            ReadingPane()
                .background(Theme.panelTint.opacity(0.3))
        }
        .navigationTitle("")
        .frame(minWidth: 900, minHeight: 560)
        .background { VisualEffectBackground() }
        .fullWindowChrome()          // green button fills the screen; window won't auto-restore
        .preferredColorScheme(.light)
        .tint(Theme.accent)          // sidebar selection + buttons follow the app accent, not the OS one
        .task { await appState.refresh() }
        // The full window had no error surface, so a failed action (e.g. "Continue this idea"
        // coming back 402 Pro-required) was a silent no-op. Mirror the panel's error line.
        .safeAreaInset(edge: .bottom) {
            if let err = appState.errorMessage {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.circle.fill").font(.system(size: 11))
                    Text(err).font(.system(size: 11.5)).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Button {
                        withAnimation(.easeOut(duration: 0.15)) { appState.errorMessage = nil }
                    } label: {
                        Image(systemName: "xmark").font(.system(size: 9, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.ink(0.4))
                }
                .foregroundStyle(Theme.stateColor("contested"))
                .padding(.horizontal, 16).padding(.vertical, 9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.regularMaterial)
                .overlay(Rectangle().fill(Theme.ink(0.1)).frame(height: 0.5), alignment: .top)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.18), value: appState.errorMessage)
    }

    private var sidebar: some View {
        // Hand-drawn selection so the highlight is Thread's accent, not the OS accent colour
        // (macOS List selection ignores .tint).
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Tab.allCases) { t in
                let on = tab == t
                Button {
                    tab = t
                } label: {
                    Label(t.rawValue, systemImage: t.icon)
                        .font(.system(size: 13, weight: on ? .semibold : .regular))
                        .foregroundStyle(on ? Color.white : Theme.ink(0.75))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 10).padding(.vertical, 7)
                        .background(
                            RoundedRectangle(cornerRadius: 7)
                                .fill(on ? Theme.accent : Color.clear)
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
        }
        .padding(8)
        .safeAreaInset(edge: .bottom) {
            HStack(spacing: 6) {
                Glyph(kind: .cloud, size: 12)
                Text(appState.planLabel).font(.system(size: 11))
                Spacer(minLength: 0)
                if let n = appState.thinkingState?.currentIdeas.count {
                    Text("\(n)").font(.system(size: 11)).monospacedDigit()
                }
            }
            .foregroundStyle(Theme.ink(0.42))
            .padding(.horizontal, 16).padding(.vertical, 10)
            .overlay(Rectangle().fill(Theme.ink(0.08)).frame(height: 0.5), alignment: .top)
        }
    }
}

// MARK: - Ideas column (shared row look, grouped + sticky, inline search)

private struct IdeaListColumn: View {
    @EnvironmentObject var appState: AppState

    private var searching: Bool {
        !appState.searchQuery.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private var lastTouched: [String: String] {
        var m: [String: String] = [:]
        for c in appState.thinkingState?.recentChanges ?? [] {
            if let e = m[c.ideaId], e >= c.createdAt { continue }
            m[c.ideaId] = c.createdAt
        }
        return m
    }

    private var loopIdeaIDs: Set<String> {
        Set((appState.thinkingState?.openLoops ?? []).filter { !$0.resolved }.map(\.ideaId))
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
        let rows = (appState.thinkingState?.currentIdeas ?? []).map { i -> IdeaRow in
            let when = lastTouched[i.id] ?? ""
            let title = cleanIdeaTitle(i.title, fallback: i.currentFormulation)
            return IdeaRow(id: i.id, title: title,
                           snippet: rowSnippet(title: title, formulation: i.currentFormulation),
                           meta: metaLine(i.sourceLabel, when),
                           isLoop: false, ideaId: i.id, when: when,
                           status: rowStatus(state: i.state, hasOpenLoop: loopIdeaIDs.contains(i.id)))
        }
        return dateBucketedGroups(rows)
    }

    var body: some View {
        VStack(spacing: 0) {
            if !searching, let s = appState.resumeSuggestion {
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
                .padding(.top, 4)
                .onAppear { appState.noteResumeShown(s.ideaId, lastActivity: appState.lastActivity(of: s.ideaId)) }
            }
            Group {
                if groups.isEmpty {
                    ColumnEmptyState(
                        icon: searching ? "magnifyingglass" : "sparkles",
                        title: searching ? "No matches" : "Nothing captured yet",
                        subtitle: searching ? nil : "Talk to ChatGPT, Claude, Gemini or Cursor and your first idea shows up here."
                    )
                } else {
                    GroupedRowScroller(groups: groups)
                }
            }
        }
        // .safeAreaInset pins the field above the scrolling rows and insets them beneath it. The
        // window now has a normal opaque titlebar (see fullWindowChrome), so AppKit already insets
        // the content below it -- a plain 10pt top pad is all this needs.
        .safeAreaInset(edge: .top, spacing: 0) {
            SearchField()
                .padding(.horizontal, 14).padding(.top, 10).padding(.bottom, 10)
                .background(Theme.panelTint.opacity(0.92))
        }
    }
}

// MARK: - Open loops column

private struct LoopListColumn: View {
    @EnvironmentObject var appState: AppState

    private var groups: [IdeaRowGroup] {
        openLoopGroups(appState.thinkingState?.openLoops ?? [], flatLabel: "Unresolved")
    }

    var body: some View {
        VStack(spacing: 0) {
            if groups.isEmpty {
                ColumnEmptyState(icon: "checkmark.circle", title: "Nothing unresolved", subtitle: nil)
            } else {
                GroupedRowScroller(groups: groups).padding(.top, 8)
            }
        }
    }
}

// MARK: - The scroller both columns share

private struct GroupedRowScroller: View {
    @EnvironmentObject var appState: AppState
    let groups: [IdeaRowGroup]

    private var selection: String? { appState.selectedIdeaId }

    private func open(_ row: IdeaRow) {
        Task { await appState.openIdea(row.ideaId) }  // sets selectedIdeaId + loads the trace
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                ForEach(groups) { g in
                    Section {
                        ForEach(g.rows) { r in
                            IdeaRowView(row: r, selected: r.ideaId == selection)
                                .contentShape(Rectangle())
                                .onTapGesture { open(r) }
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
            .padding(.bottom, 10)
        }
        .scrollContentBackground(.hidden)
    }
}

// MARK: - Inline search field (panel styling)

private struct SearchField: View {
    @EnvironmentObject var appState: AppState
    @FocusState private var focused: Bool

    private var searching: Bool {
        !appState.searchQuery.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        HStack(spacing: 6) {
            Glyph(kind: .search, size: 12).foregroundStyle(Theme.ink(0.4))
            TextField("Search ideas", text: $appState.searchQuery)
                .textFieldStyle(.plain).font(.system(size: 12.5))
                .foregroundStyle(Theme.ink(0.85))
                .focused($focused)
                .onChange(of: appState.searchQuery) { _ in Task { await appState.search() } }
            if searching {
                Button { appState.searchQuery = "" } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain).foregroundStyle(Theme.ink(0.3))
            }
        }
        .frame(height: 30).padding(.horizontal, 10)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Theme.ink(0.14), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.06), radius: 1, y: 0.5)
    }
}

// MARK: - Reading pane

private struct ReadingPane: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        if appState.selectedIdeaId != nil {
            // IdeaDetailView owns its own ScrollView -- don't nest another. Just cap it to a
            // readable measure, centre it, and keep gutters on a narrow window.
            IdeaDetailView()
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .padding(.horizontal, 24)
                .padding(.top, 10)
        } else {
            VStack(spacing: 12) {
                Glyph(kind: .window, size: 34).foregroundStyle(Theme.ink(0.22))
                Text("Select an idea")
                    .font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.ink(0.6))
                Text("Its formulation, full evolution, and open loops appear here.")
                    .font(.system(size: 12.5)).foregroundStyle(Theme.ink(0.4))
                    .multilineTextAlignment(.center).frame(maxWidth: 320)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

// MARK: - Column empty state

private struct ColumnEmptyState: View {
    let icon: String
    let title: String
    let subtitle: String?

    var body: some View {
        VStack(spacing: 11) {
            Spacer()
            Image(systemName: icon)
                .font(.system(size: 26, weight: .light)).foregroundStyle(Theme.accent)
            Text(title)
                .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Theme.ink(0.85))
            if let subtitle {
                Text(subtitle)
                    .font(.system(size: 11.5)).foregroundStyle(Theme.ink(0.5))
                    .multilineTextAlignment(.center).frame(maxWidth: 240)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity).padding(20)
    }
}
