import SwiftUI

/// Idea detail. Layout: eyebrow (source·state) + title + first-seen/last-touched, then the
/// current thought itself (governing-thought synthesis when Structure found one, else the
/// idea's own current formulation -- no label either way, weight alone carries that it's the
/// headline), then three collapsed disclosures (Structure, Evolution, Still unresolved) plus
/// Sources, then "Continue thinking" as the page's one dominant action at the bottom.
///
/// Structure fetches in the background (`AppState.fetchStructureIfNeeded`, called from
/// `openIdea`) and is session-cached per idea -- opening an idea never blocks on the network
/// (local-first reads stay true), Structure just fills in a beat later if there's something
/// there. When there's nothing (no coherent cluster, or not fetched yet), that same slot falls
/// back to the existing on-device "Related thinking" rather than showing two separate lists.
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
                    thoughtBlock(trace)
                    structureBlock(trace)
                    evolutionBlock(trace)
                    if !trace.idea.openLoops.isEmpty { unresolvedBlock(trace) }
                    sourcesBlock(trace)
                    continueBlock(trace)
                }
                .padding(.top, 2).padding(.bottom, 16)
                // A fresh identity per idea: each disclosure's collapsed/expanded @State (below)
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
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                HStack(spacing: 5) {
                    Text("\(latestSource(trace)) ·")
                    Image(systemName: IdeaStatus.symbol(trace.idea.state))
                        .font(.system(size: 8.5, weight: .semibold))
                        .foregroundStyle(trace.idea.state == "contested" ? Theme.stateColor("contested") : Theme.ink(0.4))
                    Text(trace.idea.state.capitalized)
                }
                .font(.system(size: 11, weight: .semibold)).textCase(.uppercase).kerning(0.55)
                .foregroundStyle(Theme.ink(0.4))

                Spacer(minLength: 0)

                Button {
                    appState.copyIdeaContext()
                    withAnimation(.easeOut(duration: 0.15)) { justCopied = true }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
                        withAnimation(.easeOut(duration: 0.2)) { justCopied = false }
                    }
                } label: {
                    Text(justCopied ? "Copied" : "Copy")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Theme.ink(justCopied ? 0.4 : 0.55))
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
                    Glyph(kind: .ellipsis, size: 14).foregroundStyle(Theme.ink(0.55))
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .menuIndicator(.hidden)
                .fixedSize()
            }

            if editingTitle {
                HStack {
                    TextField("Title", text: $titleDraft)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { commitTitle() }
                    Button("Done") { commitTitle() }
                }
                .padding(.top, 7)
            } else {
                Text(trace.idea.title)
                    .font(.system(size: 19, weight: .semibold)).kerning(-0.4)
                    .lineSpacing(2)
                    .foregroundStyle(Theme.ink(0.88))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 7)
            }

            HStack(spacing: 6) {
                Glyph(kind: .clock, size: 13)
                Text("First seen \(Theme.ago(trace.idea.createdAt)) · last touched \(Theme.ago(trace.idea.updatedAt))")
                    .font(.system(size: 11.5))
            }
            .foregroundStyle(Theme.ink(0.45))
            .padding(.top, 9)
        }
        .padding(.horizontal, 16)
    }

    // MARK: the current thought

    /// The headline is already the title above (unlabeled by design, per direct product
    /// direction: no "Governing thought" annotation, no mention of how it was produced). This is
    /// just the sentence under it — Structure's synthesis once found, else what's true today
    /// regardless: the idea's own current formulation. Same slot either way, so nothing about
    /// this line tells the user which one they're looking at.
    private func thoughtBlock(_ trace: IdeaTrace) -> some View {
        let statement: String = {
            if case .found(let governing) = appState.structure(for: trace.idea.id) { return governing.statement }
            return trace.idea.currentFormulation
        }()
        return Text(statement)
            .font(.system(size: 14, weight: .regular)).lineSpacing(3)
            .foregroundStyle(Theme.ink(0.75))
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 16).padding(.top, 8)
    }

    // MARK: structure (governing thought's supporting ideas, or the on-device fallback)

    /// "Why this thinking holds" when Structure found a coherent cluster; the existing on-device
    /// "Related thinking" when it didn't (or hasn't been fetched yet) -- one slot, never both, so
    /// this never shows two differently-sourced "other ideas" lists on the same page.
    @ViewBuilder
    private func structureBlock(_ trace: IdeaTrace) -> some View {
        if case .found(let governing) = appState.structure(for: trace.idea.id), !governing.members.isEmpty {
            disclosureBlock(
                title: "Why this thinking holds",
                summary: "\(governing.members.count) idea\(governing.members.count == 1 ? "" : "s")"
            ) {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(governing.members) { member in
                        relatedRow(title: member.title, fallback: member.currentFormulation, ideaId: member.id)
                    }
                }
            }
        } else {
            let related = appState.relatedIdeas(to: trace.idea.id)
            if !related.isEmpty {
                disclosureBlock(
                    title: "Related thinking",
                    summary: "\(related.count) idea\(related.count == 1 ? "" : "s")"
                ) {
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(related) { idea in
                            relatedRow(title: idea.title, fallback: idea.currentFormulation, ideaId: idea.id)
                        }
                    }
                }
            }
        }
    }

    private func relatedRow(title: String, fallback: String, ideaId: String) -> some View {
        Button {
            Task { await appState.openIdea(ideaId) }
        } label: {
            Text(cleanIdeaTitle(title, fallback: fallback))
                .font(.system(size: 12)).foregroundStyle(Theme.ink(0.68))
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .onHover { isHovering in
            if isHovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }

    // MARK: evolution

    /// Collapsed by default: a short date chain ("Aug 17 → Aug 22 → ... → Now") standing in for
    /// the full timeline below. Reuses `Theme.ago` rather than a separate calendar-date
    /// formatter, so a young account's steps read as "3d ago" here rather than "Aug 17" — a
    /// minor, accepted variance from a literal mockup match, not a new date convention.
    private func evolutionBlock(_ trace: IdeaTrace) -> some View {
        let total = trace.provenance.count
        let rows = Array(trace.provenance.enumerated().reversed())  // newest first
        return disclosureBlock(title: "How your thinking changed", summary: evolutionSummary(trace)) {
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
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.cardFill)
            .clipShape(RoundedRectangle(cornerRadius: Theme.cardCorner))
            .overlay(RoundedRectangle(cornerRadius: Theme.cardCorner).stroke(Theme.cardStroke, lineWidth: 0.5))
            .padding(.top, 2)
        }
        .accessibilityHint("\(total) step\(total == 1 ? "" : "s")")
    }

    /// A short date chain for the collapsed row: every step but the last as `Theme.ago`, the
    /// latest always literally "Now". Capped so a long history doesn't produce an absurd row.
    private func evolutionSummary(_ trace: IdeaTrace) -> String {
        let dates = trace.provenance.map { Theme.ago($0.createdAt) }.filter { !$0.isEmpty }
        guard var parts = dates.isEmpty ? nil : Array(dates.dropLast()) else { return "" }
        parts.append("Now")
        if parts.count > 4 { parts = [parts.first!, "…", parts[parts.count - 2], "Now"] }
        return parts.joined(separator: "  →  ")
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

    /// Collapsed summary counts only the still-open loops ("Still unresolved" shouldn't include
    /// a resolved one) but the expanded content keeps showing every loop, resolved included with
    /// its strikethrough — same as before this redesign, so resolving something and then
    /// wanting to look back at it isn't a capability this page lost.
    private func unresolvedBlock(_ trace: IdeaTrace) -> some View {
        let open = trace.idea.openLoops.filter { !$0.resolved }
        return disclosureBlock(
            title: "Still unresolved",
            summary: open.isEmpty ? "All resolved" : "\(open.count) question\(open.count == 1 ? "" : "s")"
        ) {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(trace.idea.openLoops) { loop in
                    Toggle(isOn: Binding(
                        get: { loop.resolved },
                        set: { v in Task { await appState.toggleLoop(loop.id, resolved: v) } }
                    )) {
                        Text(loop.statement).font(.system(size: 12)).strikethrough(loop.resolved)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .toggleStyle(.checkbox)
                }
            }
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

    @ViewBuilder
    private func sourcesBlock(_ trace: IdeaTrace) -> some View {
        let list = sources(trace)
        if !list.isEmpty {
            disclosureBlock(title: "Sources", summary: "\(list.count) conversation\(list.count == 1 ? "" : "s")") {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(list) { entry in
                        let canOpen = entry.conversationId != nil
                        Button {
                            if let cid = entry.conversationId { Task { await appState.openConversation(cid) } }
                        } label: {
                            HStack(spacing: 6) {
                                Text(entry.label).font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(canOpen ? Theme.accent : Theme.ink(0.6))
                                Text("· \(Theme.ago(entry.createdAt))")
                                    .font(.system(size: 11)).foregroundStyle(Theme.ink(0.4))
                                Spacer(minLength: 0)
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(!canOpen)
                        .onHover { isHovering in
                            guard canOpen else { return }
                            if isHovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
                        }
                    }
                }
            }
        }
    }

    // MARK: continue — the page's one dominant action

    private func continueBlock(_ trace: IdeaTrace) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let packet = appState.continuationPacket {
                ContinuationPreview(packet: packet).padding(.horizontal, 16).padding(.top, 20)
            } else if appState.continueResult != nil {
                Text("Building your handoff…").font(.system(size: 12)).foregroundStyle(.secondary)
                    .padding(.horizontal, 16).padding(.top, 20)
            } else {
                ContinueThinkingButton {
                    Task { await appState.continueThinking(sendTo: appState.preferredTool) }
                }
                .padding(.horizontal, 16).padding(.top, 22)
            }
        }
    }

    // MARK: shared disclosure

    /// The one collapsed-row-that-expands pattern, shared by Structure, Evolution, Still
    /// unresolved, and Sources. Collapsed by default, always — "Structure should initially be
    /// collapsed" was explicit product direction, not a per-section judgment call.
    private func disclosureBlock<Content: View>(
        title: String, summary: String, @ViewBuilder content: () -> Content
    ) -> some View {
        DisclosureRow(title: title, summary: summary, content: content())
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

/// Collapsed by default: a title, a quiet one-line summary, a chevron. Tap anywhere on the row
/// to expand. Its own `@State` (not the parent view's) so each disclosure keeps its own
/// expanded/collapsed state independent of the others.
private struct DisclosureRow<Content: View>: View {
    let title: String
    let summary: String
    let content: Content
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Button {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.86)) { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink(0.85))
                    Spacer(minLength: 0)
                    Text(summary).font(.system(size: 11.5)).foregroundStyle(Theme.ink(0.36))
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.ink(0.3))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { isHovering in
                if isHovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
            }

            if expanded {
                content
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.horizontal, 16).padding(.top, 18)
    }
}

/// The page's one dominant action. A quiet hover dim + pointing-hand cursor — the native
/// feedback `.buttonStyle(.plain)` alone doesn't give a custom-drawn button on macOS.
private struct ContinueThinkingButton: View {
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Text("Continue thinking")
                .font(.system(size: 13, weight: .medium)).kerning(-0.03)
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: 34)
                .background(Theme.accent.opacity(hover ? 0.92 : 1), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.black.opacity(0.1), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.18), radius: 1, y: 1)
        }
        .buttonStyle(.plain)
        .animation(.easeOut(duration: 0.1), value: hover)
        .onHover { isHovering in
            hover = isHovering
            if isHovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }
}

/// One row of the Evolution card. `grid-template-columns: 30px 1fr`, `align-items: stretch`.
/// Both the row and its content are pinned to full width so the 30pt rail column never drifts
/// (a `VStack` of rows with varying intrinsic width was centring the narrow ones — the crooked
/// rail). The divider is the mock's inset top box-shadow, drawn as a hairline over the whole row.
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
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        if let src = step.sourceLabel {
                            Text(src).font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.ink(0.5))
                        }
                        Text(Theme.ago(step.createdAt)).font(.system(size: 11)).foregroundStyle(Theme.ink(0.32))
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
                    .font(.system(size: 12.5, weight: isTop ? .medium : .regular)).kerning(-0.075)
                    .lineSpacing(2)
                    .foregroundStyle(Theme.ink(isTop ? 0.87 : 0.68))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 3)
                if let q = quote {
                    Text(q)
                        .font(.system(size: 11.5)).lineSpacing(1.7)
                        .foregroundStyle(Theme.ink(0.44))
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, 8)
                        .overlay(alignment: .leading) {
                            Rectangle().fill(Theme.ink(0.14)).frame(width: 1.5)
                        }
                        .padding(.top, 5)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.init(top: 9, leading: 0, bottom: 10, trailing: 12))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) {
            if !isTop { Rectangle().fill(Theme.rowSep).frame(height: 0.5) }
        }
    }
}

/// The 30pt timeline column: one straight 1.5pt rail + a dot. The rail is drawn as a `Path`
/// inside an overlay on `Color.clear` — nothing here demands a size, it just fills the row
/// height the content column defines. On the top row the line starts at the dot (16pt); on the
/// bottom row it stops at the dot; rows between carry a full-height segment, so the stack reads
/// as one unbroken line.
private struct EvolutionRail: View {
    let isTop: Bool
    let isBottom: Bool

    var body: some View {
        Color.clear
            .frame(width: 30)
            .overlay {
                GeometryReader { geo in
                    let x = geo.size.width / 2
                    let top: CGFloat = isTop ? 16 : 0
                    let bottom: CGFloat = isBottom ? 16 : geo.size.height
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
                    .overlay(Circle().stroke(Color.white.opacity(0.92), lineWidth: 3).padding(-0.75))
                    .padding(.top, 13)
            }
    }
}

// MARK: - Continuation preview

/// What "Continue this idea" produced. Lean by default — the one thing you left off on, plus the
/// line you'll paste. The rest of what the AI receives (established points, how the thinking
/// shifted, the open question) sits behind one disclosure; the full step-by-step evolution is the
/// Evolution card right below this one, so it isn't repeated here.
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
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.cardFill, in: RoundedRectangle(cornerRadius: Theme.cardCorner))
        .overlay(RoundedRectangle(cornerRadius: Theme.cardCorner).stroke(Theme.cardStroke, lineWidth: 0.5))
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
    /// Deliberately unlabeled: this is presented as the thought itself, not an annotated
    /// feature — no "Governing thought" eyebrow, no mention of how it was produced. Weight and
    /// size alone carry that it's the headline. No background tint, for the same reason the
    /// other blocks in this card don't have one: nothing here should read as a bolted-on widget.
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
