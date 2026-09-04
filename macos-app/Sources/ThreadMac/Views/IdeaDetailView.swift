import SwiftUI

/// Idea detail, per the "Premium macOS" redesign: source·state eyebrow, big title, a first-seen /
/// last-touched line, a Continue / Copy / ⋯ action row, then an Evolution card with a timeline.
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
                    headBlock(trace)
                    evolutionBlock(trace)
                    if !trace.idea.openLoops.isEmpty { loopsBlock(trace) }
                    relatedBlock(trace)
                }
                .padding(.top, 2).padding(.bottom, 10)
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

    // MARK: head

    private func headBlock(_ trace: IdeaTrace) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 5) {
                Text("\(latestSource(trace)) ·")
                Image(systemName: IdeaStatus.symbol(trace.idea.state))
                    .font(.system(size: 8.5, weight: .semibold))
                    .foregroundStyle(trace.idea.state == "contested" ? Theme.stateColor("contested") : Theme.ink(0.4))
                Text(trace.idea.state.capitalized)
            }
            .font(.system(size: 11, weight: .semibold)).textCase(.uppercase).kerning(0.55)
            .foregroundStyle(Theme.ink(0.4))

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

            HStack(spacing: 7) {
                // Primary — a plain solid-accent button, no split-button chevron (the design
                // shows a flat pill). White label goes on the Text, not the Button, so the
                // menu/button style can't re-resolve it to the control's default ink.
                Button {
                    Task { await appState.continueThinking(sendTo: appState.preferredTool) }
                } label: {
                    Text("Continue this idea")
                        .font(.system(size: 12, weight: .medium)).kerning(-0.03)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 11).frame(height: 26)
                        .background(Theme.accent, in: RoundedRectangle(cornerRadius: 6))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.black.opacity(0.1), lineWidth: 0.5))
                        .shadow(color: .black.opacity(0.18), radius: 1, y: 1)
                }
                .buttonStyle(.plain)

                Button {
                    appState.copyIdeaContext()
                    withAnimation(.easeOut(duration: 0.15)) { justCopied = true }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
                        withAnimation(.easeOut(duration: 0.2)) { justCopied = false }
                    }
                } label: {
                    Text(justCopied ? "Copied" : "Copy")
                        .font(.system(size: 12)).foregroundStyle(Theme.ink(justCopied ? 0.45 : 0.7))
                        .padding(.horizontal, 9).frame(height: 26)
                }
                .buttonStyle(.plain)
                .raisedControl()
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
                    Glyph(kind: .ellipsis, size: 14).foregroundStyle(Theme.ink(0.6))
                        .frame(width: 26, height: 26)
                        .contentShape(Rectangle())
                }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .menuIndicator(.hidden)
                .fixedSize()
                .raisedControl()

                Spacer(minLength: 0)
            }
            .padding(.top, 13)

            if let packet = appState.continuationPacket {
                ContinuationPreview(packet: packet).padding(.top, 12)
            } else if appState.continueResult != nil {
                Text("Building your handoff…").font(.system(size: 12)).foregroundStyle(.secondary)
                    .padding(.top, 12)
            }
        }
        .padding(.horizontal, 16)
    }

    // MARK: evolution

    /// Evolution card — an exact port of `Thread - macOS Panel v2.dc.html` (Claude Design
    /// cf5ae711). Newest step at the top with the accent dot + bold text + the source quote;
    /// one continuous rail; older steps trail below.
    private func evolutionBlock(_ trace: IdeaTrace) -> some View {
        let total = trace.provenance.count
        let rows = Array(trace.provenance.enumerated().reversed())  // newest first
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text("Evolution").font(.system(size: 12, weight: .semibold)).kerning(-0.12)
                    .foregroundStyle(Theme.ink(0.85))
                Text("\(total) step\(total == 1 ? "" : "s")")
                    .font(.system(size: 11.5)).foregroundStyle(Theme.ink(0.36))
            }
            .padding(.horizontal, 16).padding(.top, 22).padding(.bottom, 7)

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
            .padding(.horizontal, 12).padding(.bottom, 14)
        }
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

    // MARK: open loops

    /// "Related" — other ideas whose *meaning* is close to this one, found on-device. Quiet:
    /// nothing shows unless there's a genuinely near match.
    @ViewBuilder
    private func relatedBlock(_ trace: IdeaTrace) -> some View {
        let related = appState.relatedIdeas(to: trace.idea.id)
        if !related.isEmpty {
            VStack(alignment: .leading, spacing: 7) {
                Text("Related thinking").font(.system(size: 12, weight: .semibold)).kerning(-0.1)
                    .foregroundStyle(Theme.ink(0.85))
                ForEach(related) { idea in
                    Button {
                        Task { await appState.openIdea(idea.id) }
                    } label: {
                        HStack(alignment: .top, spacing: 6) {
                            Image(systemName: IdeaStatus.symbol(idea.state))
                                .font(.system(size: 8.5, weight: .regular))
                                .foregroundStyle(idea.state == "contested" ? Theme.stateColor("contested") : Theme.ink(0.35))
                                .padding(.top, 3)
                            Text(cleanIdeaTitle(idea.title, fallback: idea.currentFormulation))
                                .font(.system(size: 12)).foregroundStyle(Theme.ink(0.7))
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 10)
        }
    }

    private func loopsBlock(_ trace: IdeaTrace) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Open loops").font(.system(size: 12, weight: .semibold)).kerning(-0.1)
                .foregroundStyle(Theme.ink(0.85))
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
        .padding(.horizontal, 16).padding(.bottom, 8)
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
}
