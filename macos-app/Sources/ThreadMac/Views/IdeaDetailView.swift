import SwiftUI

/// Idea detail — an exact port of `Thread Idea Detail.dc.html` (Claude Design cf5ae711), the
/// same design project the app's other screens (RootView's header/footer chrome, the Evolution
/// timeline) were ported from. That mock's own top toolbar and bottom status bar are already
/// exactly what RootView.swift renders (back/Recent, refresh, window, plus, gearshape settings,
/// "Connected · N ideas") — this file only owns what's between them.
///
/// Layout: eyebrow (source · state, state-colored) + title + first-seen/last-touched (with Copy
/// and the "⋯" menu, absent from the static mock but real app-level functionality that must
/// stay) + the current thought (governing-thought synthesis when Structure found one, else the
/// idea's own current formulation — no label either way), then one unified card containing four
/// accordion rows separated by hairline dividers (Structure/Related, Evolution, Still unresolved,
/// Sources), then "Continue thinking" as the page's one dominant action.
///
/// Structure fetches in the background (`AppState.fetchStructureIfNeeded`, called from
/// `openIdea`) and is session-cached per idea — opening an idea never blocks on the network
/// (local-first reads stay true), Structure just fills in a beat later if there's something
/// there. When there's nothing, that same row falls back to the existing on-device "Related
/// thinking" rather than showing two separate lists.
struct IdeaDetailView: View {
    @EnvironmentObject var appState: AppState
    @State private var titleDraft = ""
    @State private var editingTitle = false
    @State private var justCopied = false

    private let states = ["developing", "established", "contested", "rejected", "dormant"]

    var body: some View {
        ScrollView {
            if let trace = appState.selectedTrace {
                VStack(alignment: .leading, spacing: 0) {
                    headerBlock(trace)
                    structureCard(trace)
                    continueBlock(trace)
                }
                .padding(.top, 6).padding(.bottom, 20)
                // A fresh identity per idea: each accordion row's collapsed/expanded @State
                // must not leak from one idea to the next when this view is reused across a
                // selection change rather than recreated.
                .id(trace.idea.id)
            } else {
                // No cached trace yet (first open of this idea, offline). A quiet skeleton, not
                // a spinner — the panel never blocks on the network.
                VStack(alignment: .leading, spacing: 10) {
                    RoundedRectangle(cornerRadius: 4).fill(Theme.ink(0.08)).frame(width: 160, height: 11)
                    RoundedRectangle(cornerRadius: 4).fill(Theme.ink(0.08)).frame(height: 13)
                    RoundedRectangle(cornerRadius: 4).fill(Theme.ink(0.08)).frame(maxWidth: 240).frame(height: 13)
                }
                .padding(20).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    // MARK: header

    private func headerBlock(_ trace: IdeaTrace) -> some View {
        let stateColor = Theme.stateColor(trace.idea.state)
        return VStack(alignment: .leading, spacing: 0) {
            // Eyebrow: source · (dot) · STATE — kept deliberately unadorned, per the mock, with
            // no trailing icons. Copy/⋯ live on the quieter metadata row below instead.
            HStack(spacing: 6) {
                Text(latestSource(trace))
                    .font(.system(size: 11, weight: .semibold)).textCase(.uppercase).kerning(0.55)
                    .foregroundStyle(Theme.ink(0.42))
                Circle().fill(stateColor).frame(width: 5, height: 5)
                Text(trace.idea.state.capitalized)
                    .font(.system(size: 11, weight: .semibold)).textCase(.uppercase).kerning(0.55)
                    .foregroundStyle(stateColor)
            }

            if editingTitle {
                HStack {
                    TextField("Title", text: $titleDraft)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { commitTitle() }
                    Button("Done") { commitTitle() }
                }
                .padding(.top, 8)
            } else {
                Text(trace.idea.title)
                    .font(.system(size: 22, weight: .semibold)).kerning(-0.48)
                    .lineSpacing(3)
                    .foregroundStyle(Theme.ink(0.9))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
            }

            HStack(spacing: 5) {
                Glyph(kind: .clock, size: 12)
                Text("First seen \(Theme.ago(trace.idea.createdAt)) · last touched \(Theme.ago(trace.idea.updatedAt))")
                    .font(.system(size: 11.5))
                Spacer(minLength: 0)
                metaActions(trace)
            }
            .foregroundStyle(Theme.ink(0.4))
            .padding(.top, 9)

            Text(thought(trace))
                .font(.system(size: 15, weight: .medium)).kerning(-0.15)
                .lineSpacing(5)
                .foregroundStyle(Theme.ink(0.86))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 16)
        }
        .padding(.horizontal, 20)
    }

    /// Copy + the "⋯" menu (Continue in / Pin / Rename / State / Delete) — real functionality
    /// the static mock doesn't show (it isn't wired to a live idea), restored here rather than
    /// dropped. Small and quiet, sized to the metadata row rather than the mock's 28pt toolbar
    /// buttons (those belong to RootView's chrome, not this page).
    private func metaActions(_ trace: IdeaTrace) -> some View {
        HStack(spacing: 10) {
            Button {
                appState.copyIdeaContext()
                withAnimation(.easeOut(duration: 0.15)) { justCopied = true }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
                    withAnimation(.easeOut(duration: 0.2)) { justCopied = false }
                }
            } label: {
                Text(justCopied ? "Copied" : "Copy")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.ink(justCopied ? 0.32 : 0.45))
            }
            .buttonStyle(.plain)
            .help("Copy this idea as text — formulation, how it developed, open questions")

            Menu {
                Section("Continue in") {
                    ForEach(AppState.AITool.allCases) { tool in
                        Button {
                            Task { await appState.continueThinking(sendTo: tool) }
                        } label: {
                            Label(tool == .cursor ? "Copy for Cursor" : "Send to \(tool.label)",
                                  systemImage: tool == .cursor ? "curlybraces" : "arrow.up.forward.app")
                        }
                    }
                }
                Divider()
                Button(appState.isPinned(trace.idea.id) ? "Unpin" : "Pin to top") {
                    appState.togglePin(trace.idea.id)
                }
                Button("Rename…") { titleDraft = trace.idea.title; editingTitle = true }
                Picker("State", selection: Binding(
                    get: { trace.idea.state },
                    set: { s in Task { await appState.setSelectedState(s) } }
                )) {
                    ForEach(states, id: \.self) { s in
                        Label(s.capitalized, systemImage: IdeaStatus.symbol(s))
                    }
                }
                Divider()
                Button("Delete idea", role: .destructive) { Task { await appState.deleteSelected() } }
            } label: {
                Glyph(kind: .ellipsis, size: 12).foregroundStyle(Theme.ink(0.4))
                    .frame(width: 16, height: 16)
                    .contentShape(Rectangle())
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .menuIndicator(.hidden)
            .fixedSize()
        }
    }

    /// Structure's synthesis when found, else the idea's own current formulation. Same slot
    /// either way — nothing about this line tells the user which one they're looking at.
    private func thought(_ trace: IdeaTrace) -> String {
        if case .found(let governing) = appState.structure(for: trace.idea.id) { return governing.statement }
        return trace.idea.currentFormulation
    }

    // MARK: the unified card — Structure/Related, Evolution, Still unresolved, Sources

    private func structureCard(_ trace: IdeaTrace) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            structureRow(trace)
            evolutionRow(trace)
            if !trace.idea.openLoops.isEmpty { unresolvedRow(trace) }
            if !sources(trace).isEmpty { sourcesRow(trace) }
        }
        .background(Color.white.opacity(0.62), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.ink(0.08), lineWidth: 0.5))
        .padding(.horizontal, 12).padding(.top, 20)
    }

    /// "Why this thinking holds" (Structure's supporting ideas) when found; the existing
    /// on-device "Related thinking" in the same row otherwise — never both, so this never shows
    /// two differently-sourced "other ideas" lists on the same page.
    @ViewBuilder
    private func structureRow(_ trace: IdeaTrace) -> some View {
        if case .found(let governing) = appState.structure(for: trace.idea.id), !governing.members.isEmpty {
            AccordionRow(title: "Why this thinking holds", showDivider: false) { _ in
                countLabel(governing.members.count, singular: "idea", plural: "ideas")
            } content: {
                itemList(governing.members.map { ($0.id, cleanIdeaTitle($0.title, fallback: $0.currentFormulation)) })
            }
        } else {
            let related = appState.relatedIdeas(to: trace.idea.id)
            if !related.isEmpty {
                AccordionRow(title: "Related thinking", showDivider: false) { _ in
                    countLabel(related.count, singular: "idea", plural: "ideas")
                } content: {
                    itemList(related.map { ($0.id, cleanIdeaTitle($0.title, fallback: $0.currentFormulation)) })
                }
            }
        }
    }

    private func itemList(_ items: [(id: String, text: String)]) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(items, id: \.id) { item in
                ItemRow {
                    Task { await appState.openIdea(item.id) }
                } content: {
                    HStack(alignment: .top, spacing: 8) {
                        Circle().fill(Theme.ink(0.28)).frame(width: 5, height: 5).padding(.top, 5)
                        Text(item.text).font(.system(size: 12.5)).lineSpacing(2)
                            .foregroundStyle(Theme.ink(0.72))
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .padding(.horizontal, 10).padding(.bottom, 12)
    }

    // MARK: evolution

    private func evolutionRow(_ trace: IdeaTrace) -> some View {
        let total = trace.provenance.count
        let rows = Array(trace.provenance.enumerated().reversed())  // newest first
        return AccordionRow(title: "How your thinking changed", showDivider: true) { isOpen in
            if !isOpen {
                Text(evolutionSummary(trace))
                    .font(.system(size: 11.5)).foregroundStyle(Theme.ink(0.38))
                    .lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: 150, alignment: .trailing)
            }
        } content: {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.offset) { shown, pair in
                    let step = pair.element
                    let isTop = shown == 0
                    EvolutionRow(
                        step: step,
                        isTop: isTop,
                        isBottom: shown == rows.count - 1,
                        quote: isTop ? quotedSource(step.sourceText) : nil,
                        onOpenSource: { cid in Task { await appState.openConversation(cid) } }
                    )
                }
            }
            .padding(.leading, 4).padding(.trailing, 6).padding(.top, 2).padding(.bottom, 10)
        }
        .accessibilityHint("\(total) step\(total == 1 ? "" : "s")")
    }

    /// A short date chain for the collapsed row: every step but the last as `Theme.ago`, the
    /// latest always literally "Now". Reuses `Theme.ago` rather than a separate calendar-date
    /// formatter, so a young account's steps read as "3d ago" here rather than "Aug 17" — a
    /// minor, accepted variance from a literal mockup match.
    private func evolutionSummary(_ trace: IdeaTrace) -> String {
        let dates = trace.provenance.map { Theme.ago($0.createdAt) }.filter { !$0.isEmpty }
        guard var parts = dates.isEmpty ? nil : Array(dates.dropLast()) else { return "" }
        parts.append("Now")
        if parts.count > 3 { parts = [parts.first!, "…", "Now"] }
        return parts.joined(separator: " → ")
    }

    /// The source message a step was grounded in, tidied for the one-line-ish quote under the
    /// current step. `nil` when there's nothing worth showing.
    private func quotedSource(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let clean = raw.replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return nil }
        let cut = clean.count > 160 ? String(clean.prefix(160)) + "…" : clean
        return "“\(cut)”"
    }

    // MARK: still unresolved

    /// Count only the still-open loops ("Still unresolved" shouldn't count a resolved one) but
    /// the expanded content keeps every loop, resolved included with its strikethrough — no
    /// capability lost, just collapsed by default.
    private func unresolvedRow(_ trace: IdeaTrace) -> some View {
        let open = trace.idea.openLoops.filter { !$0.resolved }
        return AccordionRow(title: "Still unresolved", showDivider: true) { _ in
            countLabel(open.count, singular: "question", plural: "questions", zero: "All resolved")
        } content: {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(trace.idea.openLoops) { loop in
                    ItemRow {
                        Task { await appState.toggleLoop(loop.id, resolved: !loop.resolved) }
                    } content: {
                        HStack(alignment: .top, spacing: 9) {
                            Checkbox(checked: loop.resolved).padding(.top, 1)
                            Text(loop.statement)
                                .font(.system(size: 12.5)).lineSpacing(2)
                                .foregroundStyle(Theme.ink(loop.resolved ? 0.4 : 0.75))
                                .strikethrough(loop.resolved)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            .padding(.horizontal, 8).padding(.top, 4).padding(.bottom, 12)
        }
    }

    // MARK: sources

    private struct SourceEntry: Identifiable {
        let id: String
        let label: String
        let createdAt: String
        let conversationId: String?
    }

    /// Deduped by conversation (falling back to sourceUrl, then the step itself, for older data
    /// with no conversationId), newest first. Pure local data — no network call.
    private func sources(_ trace: IdeaTrace) -> [SourceEntry] {
        var seen = Set<String>()
        var out: [SourceEntry] = []
        for step in trace.provenance.sorted(by: { $0.createdAt > $1.createdAt }) {
            let key = step.conversationId ?? step.sourceUrl ?? step.id
            guard seen.insert(key).inserted else { continue }
            out.append(SourceEntry(id: key, label: step.sourceLabel ?? "Thread",
                                    createdAt: step.createdAt, conversationId: step.conversationId))
        }
        return out
    }

    private func sourcesRow(_ trace: IdeaTrace) -> some View {
        let list = sources(trace)
        return AccordionRow(title: "Sources", showDivider: true) { _ in
            countLabel(list.count, singular: "conversation", plural: "conversations")
        } content: {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(list) { entry in
                    let canOpen = entry.conversationId != nil
                    ItemRow(cursor: canOpen) {
                        if let cid = entry.conversationId { Task { await appState.openConversation(cid) } }
                    } content: {
                        HStack(spacing: 8) {
                            Text(entry.label).font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(Theme.accent)
                            Text("· \(Theme.ago(entry.createdAt))")
                                .font(.system(size: 11)).foregroundStyle(Theme.ink(0.34))
                            Spacer(minLength: 0)
                        }
                        .frame(height: 28)
                    }
                }
            }
            .padding(.horizontal, 6).padding(.leading, 8).padding(.top, 2).padding(.bottom, 10)
        }
    }

    // MARK: continue — the page's one dominant action

    private func continueBlock(_ trace: IdeaTrace) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ContinueThinkingButton {
                Task { await appState.continueThinking(sendTo: appState.preferredTool) }
            }

            if let packet = appState.continuationPacket {
                ContinuationPreview(packet: packet).padding(.top, 10)
            } else if appState.continueResult != nil {
                Text("Building your handoff…").font(.system(size: 12)).foregroundStyle(.secondary)
                    .padding(.top, 10)
            }
        }
        .padding(.horizontal, 12).padding(.top, 16)
    }

    // MARK: shared trailing label

    private func countLabel(_ n: Int, singular: String, plural: String, zero: String? = nil) -> some View {
        Text(n == 0 ? (zero ?? "0 \(plural)") : "\(n) \(n == 1 ? singular : plural)")
            .font(.system(size: 11.5)).foregroundStyle(Theme.ink(0.4))
    }

    // MARK: helpers

    private func latestSource(_ trace: IdeaTrace) -> String {
        trace.provenance.last?.sourceLabel ?? trace.provenance.first?.sourceLabel ?? "Thread"
    }

    private func commitTitle() {
        Task { await appState.renameSelected(to: titleDraft) }
        editingTitle = false
    }
}

/// One row of the unified Structure/Evolution/Unresolved/Sources card: a fixed-height header
/// (title, a per-state trailing view, a chevron that rotates 180° when open) plus its own
/// `@State` for expanded/collapsed — each row's disclosure state is independent of the others,
/// and independent of the parent view's, so switching ideas never leaves one stuck open.
/// Collapsed by default, always: "Structure should initially be collapsed" was explicit product
/// direction, not a per-section judgment call.
private struct AccordionRow<Trailing: View, Content: View>: View {
    let title: String
    let showDivider: Bool
    @ViewBuilder let trailing: (Bool) -> Trailing
    @ViewBuilder let content: () -> Content
    @State private var expanded = false
    @State private var hover = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.86)) { expanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Text(title).font(.system(size: 12.5, weight: .semibold)).kerning(-0.075)
                        .foregroundStyle(Theme.ink(0.85))
                    Spacer(minLength: 0)
                    trailing(expanded)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.ink(0.4))
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                }
                .padding(.horizontal, 14)
                .frame(height: 42)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(hover ? Theme.rowHoverFill : Color.clear)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { isHovering in
                hover = isHovering
                if isHovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }

            if expanded {
                content()
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .overlay(alignment: .top) {
            if showDivider { Rectangle().fill(Theme.ink(0.08)).frame(height: 0.5) }
        }
    }
}

/// A tappable item inside an expanded accordion row (a related idea, an open question, a
/// source). Quiet hover fill (`Theme.itemHoverFill` — deliberately stronger than the section
/// row's own hover) + pointing-hand cursor, matching the mock's per-item `style-hover`.
private struct ItemRow<Content: View>: View {
    var cursor: Bool = true
    let action: () -> Void
    @ViewBuilder let content: () -> Content
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            content()
                .padding(.vertical, 6).padding(.horizontal, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(hover ? Theme.itemHoverFill : Color.clear, in: RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovering in
            hover = isHovering
            guard cursor else { return }
            if isHovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }
}

/// The custom checkbox from the mock — a 15×15 rounded square, ring border when unchecked,
/// solid accent fill + a white check when checked. Deliberately not the native macOS checkbox
/// (`.toggleStyle(.checkbox)`), which reads very differently from this design's flat style.
private struct Checkbox: View {
    let checked: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: 4)
            .fill(checked ? Theme.accent : Color.clear)
            .frame(width: 15, height: 15)
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(checked ? Theme.accent : Theme.ink(0.28), lineWidth: 1.4))
            .overlay {
                if checked {
                    Image(systemName: "checkmark")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(.white)
                }
            }
    }
}

/// The page's one dominant action. A quiet brightness lift on hover (the mock's
/// `filter:brightness(1.06)`) + pointing-hand cursor.
private struct ContinueThinkingButton: View {
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Text("Continue thinking")
                .font(.system(size: 14, weight: .medium)).kerning(-0.11)
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: 40)
                .background(Theme.accent, in: RoundedRectangle(cornerRadius: 9))
                .overlay(RoundedRectangle(cornerRadius: 9).fill(Color.white.opacity(hover ? 0.08 : 0)))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.black.opacity(0.08), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.2), radius: 1.5, y: 1)
        }
        .buttonStyle(.plain)
        .animation(.easeOut(duration: 0.1), value: hover)
        .onHover { isHovering in
            hover = isHovering
            if isHovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }
}

/// One row of the Evolution timeline. `grid-template-columns: 16px 1fr`, `align-items: stretch`
/// — the rail column is 16pt (the mock's exact width, narrower than a full-page timeline needs
/// since this one lives inside a card). The row and its content are pinned to full width so the
/// rail column never drifts (a `VStack` of rows with varying intrinsic width was centring the
/// narrow ones — the crooked rail).
private struct EvolutionRow: View {
    let step: ProvenanceStep
    let isTop: Bool
    let isBottom: Bool
    let quote: String?
    var onOpenSource: (String) -> Void = { _ in }

    private var canOpenSource: Bool { step.conversationId != nil }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            EvolutionRail(isTop: isTop, isBottom: isBottom)

            VStack(alignment: .leading, spacing: 0) {
                Button {
                    if let cid = step.conversationId { onOpenSource(cid) }
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        if let src = step.sourceLabel {
                            Text(src).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Theme.ink(0.6))
                        }
                        Text(Theme.ago(step.createdAt)).font(.system(size: 11)).foregroundStyle(Theme.ink(0.36))
                        if canOpenSource {
                            Image(systemName: "text.bubble")
                                .font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.accent.opacity(0.8))
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!canOpenSource)
                .help(canOpenSource ? "View the source conversation" : "")
                Text(step.formulation)
                    .font(.system(size: 12.5, weight: isTop ? .semibold : .regular)).kerning(-0.075)
                    .lineSpacing(2)
                    .foregroundStyle(Theme.ink(isTop ? 0.86 : 0.64))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 2)
                if let q = quote {
                    Text(q)
                        .font(.system(size: 11.5)).lineSpacing(1.7)
                        .foregroundStyle(Theme.ink(0.42))
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, 9)
                        .overlay(alignment: .leading) {
                            Rectangle().fill(Theme.ink(0.13)).frame(width: 1.5)
                        }
                        .padding(.top, 6)
                }
            }
            .padding(.init(top: 0, leading: 0, bottom: 14, trailing: 8))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The 16pt timeline column: one straight 1.5pt rail + a dot, matching the mock's absolute-
/// positioned rail (`top:3px`, ring shadow via a white stroke). On the top row the line starts
/// at the dot; on the bottom row it stops at the dot; rows between carry a full-height segment,
/// so the stack reads as one unbroken line.
private struct EvolutionRail: View {
    let isTop: Bool
    let isBottom: Bool

    var body: some View {
        Color.clear
            .frame(width: 16)
            .overlay {
                GeometryReader { geo in
                    let x = geo.size.width / 2
                    let top: CGFloat = isTop ? 6.5 : 0
                    let bottom: CGFloat = isBottom ? 6.5 : geo.size.height
                    Path { p in
                        p.move(to: CGPoint(x: x, y: top))
                        p.addLine(to: CGPoint(x: x, y: max(top, bottom)))
                    }
                    .stroke(Theme.rail, style: StrokeStyle(lineWidth: 1.5))
                }
            }
            .overlay(alignment: .top) {
                Circle()
                    .fill(isTop ? Theme.accent : Theme.railDot)
                    .frame(width: isTop ? 7 : 5, height: isTop ? 7 : 5)
                    .overlay(Circle().stroke(Color.white.opacity(0.75), lineWidth: 3).padding(-0.75))
                    .padding(.top, 3)
            }
    }
}

// MARK: - Continuation preview

/// What "Continue this idea" produced. Lean by default — the one thing you left off on, plus the
/// line you'll paste. The rest of what the AI receives (established points, how the thinking
/// shifted, the open question) sits behind one disclosure; the full step-by-step evolution is the
/// Evolution row right above, so it isn't repeated here. Container retinted to match the mock's
/// "handoff panel" card (white .66, radius 10, hairline stroke) — its richer content (source
/// badges, hint labels, editable field, decisions/thinkingShift disclosure) is real functionality
/// the static mock's simpler placeholder doesn't show, and stays.
private struct ContinuationPreview: View {
    let packet: ContinuationPacket
    @EnvironmentObject var appState: AppState
    @State private var showContext = false

    private func eyebrow(_ s: String) -> some View {
        Text(s).font(.system(size: 10, weight: .semibold)).textCase(.uppercase).kerning(0.5)
            .foregroundStyle(Theme.ink(0.4))
    }

    private var contested: String? {
        packet.unresolvedQuestion?.replacingOccurrences(of: "Unresolved contradiction: ", with: "")
    }
    private var hasContext: Bool {
        !packet.decisions.isEmpty
            || !(packet.thinkingShift ?? "").isEmpty
            || packet.unresolvedQuestion != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Glyph(kind: .idea, size: 12).foregroundStyle(Theme.accent)
                Text("Resume handoff").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.ink(0.6))
                Spacer(minLength: 0)
                if let tool = appState.sentToTool {
                    Label("\(tool.label) opened — press ⌘V", systemImage: "checkmark.circle")
                        .font(.system(size: 10)).foregroundStyle(Theme.accent)
                } else if appState.continueCopied {
                    Label("Copied", systemImage: "checkmark.circle")
                        .font(.system(size: 10)).foregroundStyle(Theme.accent)
                }
            }

            if let governing = packet.governingThought {
                governingThoughtBlock(governing)
            }

            if let at = packet.lastExploredAt, !Theme.ago(at).isEmpty {
                Text("Last explored: \(packet.lastExploredSource.map { "\($0) · " } ?? "")\(Theme.ago(at))")
                    .font(.system(size: 10.5)).foregroundStyle(Theme.ink(0.36))
            }

            VStack(alignment: .leading, spacing: 4) {
                eyebrow("Where you left off")
                Text(packet.whereYouLeftOff).font(.system(size: 12.5)).foregroundStyle(Theme.ink(0.85))
                    .fixedSize(horizontal: false, vertical: true)
                if packet.contested {
                    Text("Contested — a later point conflicts with the above.")
                        .font(.system(size: 11)).foregroundStyle(Theme.stateColor("contested"))
                }
            }

            // Continue-from-here: the primary surface.
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    eyebrow("Continue from here")
                    Spacer(minLength: 0)
                    if let hint = appState.continuationEngine.hint {
                        Text(hint).font(.system(size: 9.5, weight: .medium))
                            .foregroundStyle(Theme.ink(0.32))
                    }
                }
                TextField("What to ask next…", text: $appState.nextStepDraft, axis: .vertical)
                    .textFieldStyle(.plain).font(.system(size: 12.5))
                    .foregroundStyle(Theme.ink(0.85)).lineLimit(1 ... 4)
                    .padding(8)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.ink(0.12), lineWidth: 0.5))
            }

            // Everything else the AI receives — one disclosure, collapsed by default.
            if hasContext {
                VStack(alignment: .leading, spacing: 10) {
                    if showContext {
                        if !packet.decisions.isEmpty {
                            block("You'd established") {
                                ForEach(packet.decisions) { d in
                                    HStack(alignment: .top, spacing: 6) {
                                        Text("•").foregroundStyle(Theme.ink(0.3))
                                        Text(d.statement).font(.system(size: 12)).foregroundStyle(Theme.ink(0.78))
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                }
                            }
                        }
                        if let shift = packet.thinkingShift, !shift.isEmpty {
                            block("How your thinking changed") {
                                Text(shift).font(.system(size: 12.5)).foregroundStyle(Theme.ink(0.85))
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        if let q = contested {
                            block("You hadn't resolved") {
                                Text(q).font(.system(size: 12.5)).foregroundStyle(Theme.ink(0.85))
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    Button {
                        withAnimation(.easeOut(duration: 0.16)) { showContext.toggle() }
                    } label: {
                        HStack(spacing: 3) {
                            Text(showContext ? "Hide context" : "Show the full handoff")
                            Image(systemName: "chevron.down")
                                .font(.system(size: 8, weight: .semibold))
                                .rotationEffect(.degrees(showContext ? 180 : 0))
                        }
                        .font(.system(size: 10.5, weight: .medium)).foregroundStyle(Theme.accent)
                    }
                    .buttonStyle(.plain)
                }
            }

            HStack {
                Spacer()
                Button("Copy") { appState.recopyContinuation() }
                    .buttonStyle(.plain).font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.accent)
            }
        }
        .padding(13).frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.66), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.ink(0.08), lineWidth: 0.5))
    }

    @ViewBuilder
    private func block<Content: View>(_ label: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            eyebrow(label)
            content()
        }
    }

    /// This idea turned out to be part of one argument with a few others — the Minto-style
    /// synthesis (see GoverningThought). Leads the card, ahead of "Where you left off", matching
    /// the server's own `text` render order — it's the wider claim the rest sits inside of.
    /// Deliberately unlabeled: no "Governing thought" eyebrow, no mention of how it was produced.
    private func governingThoughtBlock(_ governing: GoverningThought) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(governing.statement)
                .font(.system(size: 14.5, weight: .semibold)).kerning(-0.1)
                .foregroundStyle(Theme.ink(0.92))
                .fixedSize(horizontal: false, vertical: true)
            if !governing.members.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text(governing.kind.capitalized)
                        .font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.ink(0.4))
                    ForEach(governing.members) { member in
                        Button {
                            Task { await appState.openIdea(member.id) }
                        } label: {
                            Text(cleanIdeaTitle(member.title, fallback: member.currentFormulation))
                                .font(.system(size: 11.5)).foregroundStyle(Theme.accent)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.top, 2)
            }
        }
    }
}
