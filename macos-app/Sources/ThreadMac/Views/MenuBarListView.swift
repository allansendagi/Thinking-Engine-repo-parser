import SwiftUI

struct MenuBarListView: View {
    @EnvironmentObject var appState: AppState
    @FocusState private var searchFocused: Bool
    @State private var selection: String?

    private var searching: Bool {
        !appState.searchQuery.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private var lastChange: [String: String] {
        var map: [String: String] = [:]
        for c in appState.thinkingState?.recentChanges ?? [] {
            if let existing = map[c.ideaId], existing >= c.createdAt { continue }
            map[c.ideaId] = c.createdAt
        }
        return map
    }

    private var loops: [ThinkingStateResponse.OpenLoopEntry] {
        (appState.thinkingState?.openLoops ?? []).filter { !$0.resolved }
    }

    private var ideas: [IdeaSummary] {
        let loopIdeaIds = Set(loops.map(\.ideaId))
        return (appState.thinkingState?.currentIdeas ?? []).filter { !loopIdeaIds.contains($0.id) }
    }

    /// Flat id list in visual order, so ⏎ can resolve the current selection.
    private var orderedRowIDs: [String] {
        searching
            ? appState.searchResults.map(\.id)
            : ideas.map(\.id) + loops.map { "loop:" + $0.loopId }
    }

    var body: some View {
        VStack(spacing: 0) {
            searchField
            Divider()
            content
        }
        .onAppear { searchFocused = true }
    }

    // MARK: search

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary).font(.system(size: 12))
            TextField("Where was I with…", text: $appState.searchQuery)
                .textFieldStyle(.plain)
                .focused($searchFocused)
                .onChange(of: appState.searchQuery) { _ in Task { await appState.search() } }
                .onKeyPress(.downArrow) {
                    if let first = orderedRowIDs.first { selection = first; searchFocused = false }
                    return .handled
                }
            if searching {
                Button { appState.searchQuery = "" } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain).foregroundStyle(.tertiary)
            } else {
                Text("⌘⇧T").font(.system(size: 10, design: .monospaced)).foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    // MARK: content

    @ViewBuilder private var content: some View {
        if appState.isLoading && (appState.thinkingState?.currentIdeas.isEmpty ?? true) && !searching {
            SkeletonList()
        } else if !searching && ideas.isEmpty && loops.isEmpty {
            EmptyState(showOnboarding: !appState.onboardingDismissed) { appState.dismissOnboarding() }
        } else {
            List(selection: $selection) {
                if searching {
                    resultsSection
                } else {
                    if !appState.onboardingDismissed { onboardingRow }
                    ideasSection
                    loopsSection
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 2)
            .onKeyPress(.return) { openSelected(); return .handled }
            .onKeyPress(.rightArrow) { openSelected(); return .handled }
        }
    }

    private var onboardingRow: some View {
        OnboardingCard { appState.dismissOnboarding() }
            .listRowInsets(EdgeInsets(top: 12, leading: 12, bottom: 4, trailing: 12))
            .listRowSeparator(.hidden)
            .selectionDisabled()
    }

    @ViewBuilder private var resultsSection: some View {
        if appState.searchResults.isEmpty {
            Text("No matching ideas.").font(.system(size: 12)).foregroundStyle(.secondary)
                .listRowSeparator(.hidden).selectionDisabled()
        } else {
            Section {
                ForEach(appState.searchResults) { r in
                    IdeaRow(title: displayTitle(r.title, fallback: r.currentFormulation),
                            formulation: r.currentFormulation, state: r.state, when: nil,
                            onOpen: { Task { await appState.openIdea(r.id) } })
                        .tag(r.id)
                }
            }
        }
    }

    @ViewBuilder private var ideasSection: some View {
        if !ideas.isEmpty {
            Section(header: SectionLabel("Recent ideas")) {
                ForEach(ideas) { idea in
                    IdeaRow(title: displayTitle(idea.title, fallback: idea.currentFormulation),
                            formulation: idea.currentFormulation, state: idea.state,
                            when: lastChange[idea.id],
                            onOpen: { Task { await appState.openIdea(idea.id) } })
                        .tag(idea.id)
                }
            }
        }
    }

    @ViewBuilder private var loopsSection: some View {
        if !loops.isEmpty {
            Section(header: SectionLabel("Open loops")) {
                ForEach(loops) { loop in
                    LoopRow(question: loop.statement,
                            onOpen: { Task { await appState.openIdea(loop.ideaId) } })
                        .tag("loop:" + loop.loopId)
                }
            }
        }
    }

    // MARK: actions

    private func openSelected() {
        guard let sel = selection else { return }
        if sel.hasPrefix("loop:") {
            let loopId = String(sel.dropFirst(5))
            if let loop = loops.first(where: { $0.loopId == loopId }) {
                Task { await appState.openIdea(loop.ideaId) }
            }
        } else {
            Task { await appState.openIdea(sel) }
        }
    }

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

// MARK: - Rows

private struct SectionLabel: View {
    let text: String
    init(_ t: String) { text = t }
    var body: some View {
        Text(text).sectionHeader().padding(.top, 6).padding(.bottom, 2)
    }
}

private struct IdeaRow: View {
    let title: String
    let formulation: String
    let state: String
    let when: String?
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(title).font(.system(size: 13, weight: .medium)).lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let when, !when.isEmpty {
                        Text(Theme.relative(when)).font(.system(size: 10)).foregroundStyle(.tertiary)
                    }
                    StatePill(state: state)
                }
                Text(formulation).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
            }
            .padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowSeparator(.hidden)
    }
}

private struct LoopRow: View {
    let question: String
    let onOpen: () -> Void
    var body: some View {
        Button(action: onOpen) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "circle.dashed").font(.system(size: 11)).foregroundStyle(Theme.accent)
                    .padding(.top, 1)
                Text(question).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowSeparator(.hidden)
    }
}

struct StatePill: View {
    let state: String
    var body: some View {
        Text(state)
            .font(.system(size: 9, weight: .medium)).textCase(.uppercase).kerning(0.4)
            .foregroundStyle(Theme.stateColor(state))
            .padding(.horizontal, 5).padding(.vertical, 2)
            .background(Theme.stateColor(state).opacity(0.14))
            .clipShape(Capsule())
    }
}

// MARK: - Skeleton / empty / onboarding

private struct SkeletonList: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(0..<4, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 6) {
                    RoundedRectangle(cornerRadius: 4).frame(width: 160, height: 11)
                    RoundedRectangle(cornerRadius: 4).frame(height: 9)
                    RoundedRectangle(cornerRadius: 4).frame(width: 220, height: 9)
                }
                .foregroundStyle(.quaternary)
                .redacted(reason: .placeholder)
                .shimmer()
            }
            Spacer()
        }
        .padding(14)
    }
}

private struct EmptyState: View {
    let showOnboarding: Bool
    let dismiss: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Spacer()
            Image(systemName: "sparkles")
                .font(.system(size: 30, weight: .light))
                .foregroundStyle(Theme.accent.gradient)
            Text("Nothing captured yet")
                .font(.system(size: 14, weight: .semibold))
            Text("Talk to ChatGPT, Claude, or Gemini and your first idea shows up here.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 260)
            if showOnboarding {
                OnboardingCard(dismiss: dismiss).padding(.top, 6).frame(maxWidth: 300)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .padding(20)
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
            step(1, "Install the browser extension", "chrome://extensions → Load unpacked")
            step(2, "Start talking", "Use ChatGPT, Claude, Gemini or Cursor as normal")
            step(3, "Press ⌘⇧T", "Recall any idea from anywhere")
        }
        .padding(12)
        .background(Theme.cardFill)
        .overlay(RoundedRectangle(cornerRadius: Theme.cardCorner).stroke(Theme.cardStroke, lineWidth: 0.5))
        .clipShape(RoundedRectangle(cornerRadius: Theme.cardCorner))
    }

    private func step(_ n: Int, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("\(n)")
                .font(.system(size: 9, weight: .bold, design: .rounded))
                .foregroundStyle(Theme.accent)
                .frame(width: 14, height: 14)
                .background(Theme.accent.opacity(0.15)).clipShape(Circle())
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.system(size: 11, weight: .medium))
                Text(detail).font(.system(size: 10)).foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - Shimmer

private struct Shimmer: ViewModifier {
    @State private var phase: CGFloat = -1
    func body(content: Content) -> some View {
        content.overlay(
            LinearGradient(
                colors: [.clear, .white.opacity(0.35), .clear],
                startPoint: .leading, endPoint: .trailing
            )
            .frame(width: 80)
            .offset(x: phase * 300)
            .blendMode(.plusLighter)
        )
        .mask(content)
        .onAppear {
            withAnimation(.linear(duration: 1.3).repeatForever(autoreverses: false)) { phase = 2 }
        }
    }
}
private extension View {
    func shimmer() -> some View { modifier(Shimmer()) }
}
