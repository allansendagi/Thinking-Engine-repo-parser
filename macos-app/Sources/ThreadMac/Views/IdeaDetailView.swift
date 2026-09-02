import SwiftUI

/// Idea detail, per the "Premium macOS" redesign: source·state eyebrow, big title, a first-seen /
/// last-touched line, a Continue / Copy / ⋯ action row, then an Evolution card with a timeline.
struct IdeaDetailView: View {
    @EnvironmentObject var appState: AppState
    @State private var titleDraft = ""
    @State private var editingTitle = false

    private let states = ["developing", "established", "contested", "rejected", "dormant"]

    var body: some View {
        ScrollView {
            if let trace = appState.selectedTrace {
                VStack(alignment: .leading, spacing: 0) {
                    headBlock(trace)
                    evolutionBlock(trace)
                    if !trace.idea.openLoops.isEmpty { loopsBlock(trace) }
                }
                .padding(.top, 2).padding(.bottom, 10)
            } else {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(40)
            }
        }
    }

    // MARK: head

    private func headBlock(_ trace: IdeaTrace) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("\(latestSource(trace)) · \(trace.idea.state.capitalized)")
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
                    Task { await appState.continueThinking(sendTo: nil) }
                } label: {
                    Text("Copy")
                        .font(.system(size: 12)).foregroundStyle(Theme.ink(0.7))
                        .padding(.horizontal, 9).frame(height: 26)
                }
                .buttonStyle(.plain)
                .raisedControl()

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
                    )) { ForEach(states, id: \.self) { Text($0.capitalized) } }
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

    private func evolutionBlock(_ trace: IdeaTrace) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text("Evolution").font(.system(size: 12, weight: .semibold)).kerning(-0.1)
                    .foregroundStyle(Theme.ink(0.85))
                Text("\(trace.provenance.count) step\(trace.provenance.count == 1 ? "" : "s")")
                    .font(.system(size: 11.5)).foregroundStyle(Theme.ink(0.36))
            }
            .padding(.horizontal, 16).padding(.top, 22).padding(.bottom, 7)

            let steps = Array(trace.provenance.enumerated().reversed())  // newest first
            VStack(spacing: 0) {
                ForEach(steps, id: \.offset) { idx, step in
                    EvolutionRow(
                        step: step,
                        isCurrent: idx == trace.provenance.count - 1,
                        isFirstShown: idx == steps.first?.offset,
                        isLastShown: idx == steps.last?.offset
                    )
                    if idx != steps.last?.offset {
                        Rectangle().fill(Theme.ink(0.07)).frame(height: 0.5)
                    }
                }
            }
            .background(Theme.cardFill, in: RoundedRectangle(cornerRadius: 9))  // mock: rgba(255,255,255,.66)
            .overlay(RoundedRectangle(cornerRadius: 9).stroke(Theme.ink(0.09), lineWidth: 0.5))
            .padding(.horizontal, 12).padding(.bottom, 14)
        }
    }

    // MARK: open loops

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

private struct EvolutionRow: View {
    let step: ProvenanceStep
    let isCurrent: Bool
    let isFirstShown: Bool
    let isLastShown: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            // rail column (30pt)
            ZStack(alignment: .top) {
                Rectangle().fill(Theme.ink(0.12)).frame(width: 1.5)
                    .padding(.top, isFirstShown ? 16 : 0)
                    .padding(.bottom, isLastShown ? 100 : 0)
                Circle()
                    .fill(isCurrent ? Theme.accent : Theme.ink(0.28))
                    .frame(width: isCurrent ? 7 : 5, height: isCurrent ? 7 : 5)
                    .overlay(Circle().stroke(Color.white.opacity(0.9), lineWidth: 3))  // mock: 0 0 0 3px rgba(255,255,255,.9)
                    .padding(.top, 13)
            }
            .frame(width: 30)
            .frame(maxHeight: .infinity)

            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    if let src = step.sourceLabel {
                        Text(src).font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.ink(0.5))
                    }
                    Text(Theme.ago(step.createdAt)).font(.system(size: 11)).foregroundStyle(Theme.ink(0.32))
                }
                Text(step.formulation)
                    .font(.system(size: 12.5, weight: isCurrent ? .medium : .regular)).kerning(-0.06)
                    .foregroundStyle(Theme.ink(isCurrent ? 0.87 : 0.68))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 3)
                if isCurrent, let q = step.sourceText, !q.isEmpty {
                    Text("“\(q.prefix(120))\(q.count > 120 ? "…" : "")”")
                        .font(.system(size: 11.5)).foregroundStyle(Theme.ink(0.44))
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.leading, 8).padding(.top, 5)
                        .overlay(Rectangle().fill(Theme.ink(0.14)).frame(width: 1.5), alignment: .leading)
                }
            }
            .padding(.trailing, 12).padding(.vertical, 9)
        }
    }
}

// MARK: - Continuation preview

/// What "Continue this idea" produced: a compact, source-backed handoff. The paste string is the
/// server's `text`, copied verbatim; the only editable part is the last line.
private struct ContinuationPreview: View {
    let packet: ContinuationPacket
    @EnvironmentObject var appState: AppState
    @State private var showAllEvolution = false

    /// Match the paste text: show everything up to 4 steps, else first + latest two.
    private var shownEvolution: [ContinuationPacket.EvolutionStep] {
        let all = packet.evolution
        if showAllEvolution || all.count <= 4 { return all }
        return [all.first!] + all.suffix(2)
    }
    private var hiddenEvolutionCount: Int {
        max(0, packet.evolution.count - shownEvolution.count)
    }

    private func eyebrow(_ s: String) -> some View {
        Text(s).font(.system(size: 10, weight: .semibold)).textCase(.uppercase).kerning(0.5)
            .foregroundStyle(Theme.ink(0.4))
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

            VStack(alignment: .leading, spacing: 4) {
                eyebrow("Where you left off")
                Text(packet.whereYouLeftOff).font(.system(size: 12.5)).foregroundStyle(Theme.ink(0.85))
                    .fixedSize(horizontal: false, vertical: true)
                if packet.contested {
                    Text("This idea is contested — a later point conflicts with the above.")
                        .font(.system(size: 11)).foregroundStyle(Theme.stateColor("contested"))
                }
            }

            if packet.evolutionUnverified {
                VStack(alignment: .leading, spacing: 4) {
                    eyebrow("How this evolved")
                    Text("Captured before source-role verification — its earlier wording isn't shown.")
                        .font(.system(size: 11)).foregroundStyle(Theme.ink(0.5))
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else if !packet.evolution.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    eyebrow("How this evolved")
                    ForEach(shownEvolution) { step in
                        HStack(alignment: .top, spacing: 6) {
                            Text("•").foregroundStyle(Theme.ink(0.3))
                            VStack(alignment: .leading, spacing: 1) {
                                Text("\(Theme.ago(step.when))\(step.source.map { " · \($0)" } ?? "")")
                                    .font(.system(size: 10)).foregroundStyle(Theme.ink(0.36))
                                Text(step.formulation).font(.system(size: 12)).foregroundStyle(Theme.ink(0.72))
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    if hiddenEvolutionCount > 0 {
                        Button("Show all \(packet.evolution.count) steps") { showAllEvolution = true }
                            .buttonStyle(.plain).font(.system(size: 10, weight: .medium))
                            .foregroundStyle(Theme.accent)
                    } else if showAllEvolution && packet.evolution.count > 4 {
                        Button("Show less") { showAllEvolution = false }
                            .buttonStyle(.plain).font(.system(size: 10, weight: .medium))
                            .foregroundStyle(Theme.ink(0.4))
                    }
                }
            }

            if let q = packet.unresolvedQuestion {
                VStack(alignment: .leading, spacing: 4) {
                    eyebrow("Unresolved question")
                    Text(q.replacingOccurrences(of: "Unresolved contradiction: ", with: ""))
                        .font(.system(size: 12.5)).foregroundStyle(Theme.ink(0.85))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            VStack(alignment: .leading, spacing: 5) {
                eyebrow("Continue from here")
                TextField("What to ask next…", text: $appState.nextStepDraft, axis: .vertical)
                    .textFieldStyle(.plain).font(.system(size: 12.5))
                    .foregroundStyle(Theme.ink(0.85)).lineLimit(1 ... 4)
                    .padding(8)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.ink(0.12), lineWidth: 0.5))
                HStack {
                    Spacer()
                    Button("Copy again") { appState.recopyContinuation() }
                        .buttonStyle(.plain).font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Theme.accent)
                }
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.cardFill, in: RoundedRectangle(cornerRadius: Theme.cardCorner))
        .overlay(RoundedRectangle(cornerRadius: Theme.cardCorner).stroke(Theme.cardStroke, lineWidth: 0.5))
    }
}
