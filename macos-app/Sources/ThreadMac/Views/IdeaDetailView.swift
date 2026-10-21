import SwiftUI

/// The idea page, in the standard macOS grouped-form layout. Top to bottom: the idea (state,
/// title, current thought), what you decided, the questions still open, then the history folded
/// away (how your thinking changed, why it holds, options weighed, sources), then the one
/// action: Continue. Decisions and open questions are what you open an idea to find, so they
/// start open; Structure and the rest of the history start collapsed (product rule).
///
/// Structure fetches in the background (`AppState.fetchStructureIfNeeded`) and is cached per
/// idea, so opening an idea never waits on the network. With nothing to show, that row falls back
/// to the on-device "Related thinking" instead of showing two lists.
struct IdeaDetailView: View {
    @EnvironmentObject var appState: AppState
    @State private var titleDraft = ""
    @State private var editingTitle = false
    @State private var justCopied = false
    @State private var openSections: Set<String> = DisclosureDefaults.startOpen

    private let states = ["developing", "established", "contested", "rejected", "dormant"]

    var body: some View {
        if let trace = appState.selectedTrace {
            Form {
                headerSection(trace)
                if !trace.idea.decisions.isEmpty { decidedSection(trace) }
                if !trace.idea.openLoops.isEmpty { questionsSection(trace) }
                historySection(trace)
                continueSection(trace)
            }
            .formStyle(.grouped)
            // A fresh identity per idea so folded/open state never leaks to the next idea.
            .id(trace.idea.id)
        } else {
            // No cached trace yet (first open, offline): a quiet placeholder, never a blocking spinner.
            VStack(alignment: .leading, spacing: 10) {
                RoundedRectangle(cornerRadius: 4).fill(.quaternary).frame(width: 160, height: 12)
                RoundedRectangle(cornerRadius: 4).fill(.quaternary).frame(height: 14)
                RoundedRectangle(cornerRadius: 4).fill(.quaternary).frame(maxWidth: 240).frame(height: 14)
            }
            .padding(20).frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel("Loading idea")
        }
    }

    private func disclosure(_ key: String) -> Binding<Bool> {
        Binding(get: { openSections.contains(key) },
                set: { if $0 { openSections.insert(key) } else { openSections.remove(key) } })
    }

    // MARK: header

    private func headerSection(_ trace: IdeaTrace) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Label(trace.idea.state.capitalized, systemImage: IdeaStatus.symbol(trace.idea.state))
                        .foregroundStyle(IdeaStatus.tint(trace.idea.state))
                    Text("· \(latestSource(trace))").foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    metaActions(trace)
                }
                .font(.subheadline)

                if editingTitle {
                    HStack {
                        TextField("Title", text: $titleDraft).onSubmit { commitTitle() }
                        Button("Done") { commitTitle() }
                    }
                } else {
                    Text(trace.idea.title)
                        .font(.title2.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                }

                Text(thought(trace))
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)

                Text("First seen \(Theme.ago(trace.idea.createdAt)) · last touched \(Theme.ago(trace.idea.updatedAt))")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
        }
    }

    /// Copy + the "…" menu (Continue in / Pin / Rename / State / Merge / Delete).
    private func metaActions(_ trace: IdeaTrace) -> some View {
        HStack(spacing: 10) {
            Button(justCopied ? "Copied" : "Copy") {
                appState.copyIdeaContext()
                justCopied = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { justCopied = false }
            }
            .buttonStyle(.borderless)
            .help("Copy this idea as text: formulation, how it developed, open questions")

            Menu {
                Section("Continue in") {
                    ForEach(AppState.AITool.allCases) { tool in
                        Button {
                            Task { await appState.continueInNativeApp(tool) }
                        } label: {
                            Label(tool.label, systemImage: "arrow.up.forward.app")
                        }
                    }
                }
                Divider()
                Button(appState.isPinned(trace.idea.id) ? "Unpin" : "Pin to Top") {
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
                IdeaVerdictItems(ideaId: trace.idea.id)
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .accessibilityLabel("More Actions")
        }
    }

    /// Structure's synthesis when found, else the idea's own current formulation.
    private func thought(_ trace: IdeaTrace) -> String {
        if case .found(let governing) = appState.structure(for: trace.idea.id) { return governing.statement }
        return trace.idea.currentFormulation
    }

    // MARK: what you decided, and what is still open

    private func decidedSection(_ trace: IdeaTrace) -> some View {
        Section("What You Decided") {
            ForEach(trace.idea.decisions.sorted { $0.decidedAt > $1.decidedAt }) { d in
                VStack(alignment: .leading, spacing: 2) {
                    Text(d.statement).fixedSize(horizontal: false, vertical: true)
                    Text(Theme.ago(d.decidedAt)).font(.caption).foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func questionsSection(_ trace: IdeaTrace) -> some View {
        let open = trace.idea.openLoops.filter { !$0.resolved }.count
        return Section {
            QuestionList(loops: trace.idea.openLoops) { loop in
                Task { await appState.toggleLoop(loop.id, resolved: !loop.resolved) }
            }
        } header: {
            HStack {
                Text("Open Questions")
                Spacer()
                Text(open == 0 ? "All answered" : "\(open) open").foregroundStyle(.secondary)
            }
        }
    }

    // MARK: history, folded

    private func historySection(_ trace: IdeaTrace) -> some View {
        Section("History") {
            evolutionGroup(trace)
            structureGroup(trace)
            if let map = appState.thinkingMaps[trace.idea.id], !map.isEmpty { weighingGroup(map) }
            if !sources(trace).isEmpty { sourcesGroup(trace) }
        }
    }

    private func evolutionGroup(_ trace: IdeaTrace) -> some View {
        let rows = Array(trace.provenance.enumerated().reversed())  // newest first
        return DisclosureGroup(isExpanded: disclosure("How your thinking changed")) {
            ForEach(Array(rows.enumerated()), id: \.offset) { shown, pair in
                let step = pair.element
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        if let src = step.sourceLabel { Text(src).fontWeight(.medium) }
                        Text(Theme.ago(step.createdAt))
                        if let cid = step.conversationId {
                            Spacer(minLength: 0)
                            Button("View Conversation") { Task { await appState.openConversation(cid) } }
                                .buttonStyle(.link)
                        }
                    }
                    .font(.caption).foregroundStyle(.secondary)
                    Text(step.formulation)
                        .fontWeight(shown == 0 ? .semibold : .regular)
                        .fixedSize(horizontal: false, vertical: true)
                    if shown == 0, let q = quotedSource(step.sourceText) {
                        Text(q).font(.callout).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.vertical, 2)
            }
        } label: {
            groupLabel("How Your Thinking Changed", count: trace.provenance.count, singular: "step", plural: "steps")
        }
    }

    /// "Why this thinking holds" (Structure's supporting ideas) when found; otherwise the
    /// on-device "Related thinking". Never both.
    @ViewBuilder
    private func structureGroup(_ trace: IdeaTrace) -> some View {
        if case .found(let governing) = appState.structure(for: trace.idea.id), !governing.members.isEmpty {
            DisclosureGroup(isExpanded: disclosure("Why this thinking holds")) {
                ideaLinks(governing.members.map { ($0.id, cleanIdeaTitle($0.title, fallback: $0.currentFormulation)) })
            } label: {
                groupLabel("Why This Thinking Holds", count: governing.members.count, singular: "idea", plural: "ideas")
            }
        } else {
            let related = appState.relatedIdeas(to: trace.idea.id)
            if !related.isEmpty {
                DisclosureGroup(isExpanded: disclosure("Related thinking")) {
                    ideaLinks(related.map { ($0.id, cleanIdeaTitle($0.title, fallback: $0.currentFormulation)) })
                } label: {
                    groupLabel("Related Thinking", count: related.count, singular: "idea", plural: "ideas")
                }
            }
        }
    }

    private func ideaLinks(_ items: [(id: String, text: String)]) -> some View {
        ForEach(items, id: \.id) { item in
            Button { Task { await appState.openIdea(item.id) } } label: {
                Text(item.text).multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.link)
        }
    }

    /// What was weighed (open / ruled out / chosen) and where the thinking is unfinished.
    private func weighingGroup(_ map: ThinkingMap) -> some View {
        DisclosureGroup(isExpanded: disclosure(map.gaps.isEmpty ? "Options weighed" : "Unfinished thinking")) {
            ForEach(map.gaps, id: \.self) { gap in
                Label(gap.message, systemImage: "circle.dashed")
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(map.options, id: \.self) { option in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(optionLabel(option.status)).font(.caption).foregroundStyle(.secondary)
                        .frame(width: 70, alignment: .leading)
                    Text(option.statement)
                        .strikethrough(option.status == "rejected")
                        .foregroundStyle(option.status == "rejected" ? .secondary : .primary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
        } label: {
            if map.gaps.isEmpty {
                groupLabel("Options Weighed", count: map.options.count, singular: "option", plural: "options")
            } else {
                groupLabel("Unfinished Thinking", count: map.gaps.count, singular: "gap", plural: "gaps")
            }
        }
    }

    private func optionLabel(_ status: String) -> String {
        switch status {
        case "chosen": return "Chosen"
        case "rejected": return "Ruled out"
        default: return "Weighing"
        }
    }

    // MARK: sources

    private struct SourceEntry: Identifiable {
        let id: String
        let label: String
        let createdAt: String
        let conversationId: String?
    }

    /// Deduped by conversation (falling back to sourceUrl, then the step), newest first. Local data only.
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

    private func sourcesGroup(_ trace: IdeaTrace) -> some View {
        let list = sources(trace)
        return DisclosureGroup(isExpanded: disclosure("Sources")) {
            ForEach(list) { entry in
                if let cid = entry.conversationId {
                    Button { Task { await appState.openConversation(cid) } } label: {
                        Text("\(entry.label) · \(Theme.ago(entry.createdAt))")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.link)
                } else {
                    Text("\(entry.label) · \(Theme.ago(entry.createdAt))").foregroundStyle(.secondary)
                }
            }
        } label: {
            groupLabel("Sources", count: list.count, singular: "conversation", plural: "conversations")
        }
    }

    private func groupLabel(_ title: String, count: Int, singular: String, plural: String) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text("\(count) \(count == 1 ? singular : plural)").foregroundStyle(.secondary)
        }
    }

    // MARK: continue

    private func continueSection(_ trace: IdeaTrace) -> some View {
        let target = appState.preferredTool
        return Section {
            VStack(spacing: 8) {
                Button {
                    Task { await appState.continueInNativeApp(target) }
                } label: {
                    Text("Continue in \(target.label)").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

                Menu("Continue in a Different App") {
                    ForEach(AppState.AITool.allCases) { tool in
                        Button {
                            Task { await appState.continueInNativeApp(tool) }
                        } label: {
                            Label(tool.label, systemImage: tool == target ? "checkmark" : "arrow.up.forward.app")
                        }
                    }
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
            }
            .frame(maxWidth: .infinity)

            if let packet = appState.continuationPacket {
                ContinuationPreview(packet: packet)
            } else if appState.continueResult != nil {
                Text("Building your handoff…").foregroundStyle(.secondary)
            }
        }
    }

    // MARK: helpers

    /// The source message a step was grounded in, tidied to a short quote. `nil` when empty.
    private func quotedSource(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let clean = raw.replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "  ", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return nil }
        let cut = clean.count > 160 ? String(clean.prefix(160)) + "…" : clean
        return "“\(cut)”"
    }

    private func latestSource(_ trace: IdeaTrace) -> String {
        trace.provenance.last?.sourceLabel ?? trace.provenance.first?.sourceLabel ?? "Thread"
    }

    private func commitTitle() {
        Task { await appState.renameSelected(to: titleDraft) }
        editingTitle = false
    }
}

/// Section titles that start open. Always empty in the shipping app except through the view's own
/// defaults; screenshots and tests set it to show a folded section open.
@MainActor enum DisclosureDefaults { static var startOpen: Set<String> = [] }

// MARK: - Continuation preview

/// What "Continue this idea" produced: where you left off, the line to continue from, and (behind
/// one disclosure) everything else the AI receives.
private struct ContinuationPreview: View {
    let packet: ContinuationPacket
    @EnvironmentObject var appState: AppState
    @State private var showContext = false

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
            HStack {
                Text("Resume Handoff").font(.headline)
                Spacer(minLength: 0)
                handoffStatus
            }

            if let governing = packet.governingThought { governingThoughtBlock(governing) }

            if let at = packet.lastExploredAt, !Theme.ago(at).isEmpty {
                Text("Last explored: \(packet.lastExploredSource.map { "\($0) · " } ?? "")\(Theme.ago(at))")
                    .font(.footnote).foregroundStyle(.secondary)
            }

            labeled("Where You Left Off") {
                Text(packet.whereYouLeftOff).fixedSize(horizontal: false, vertical: true)
                if packet.contested {
                    Text("Contested: a later point conflicts with the above.")
                        .font(.footnote).foregroundStyle(Theme.stateColor("contested"))
                }
            }

            labeled("Continue From Here") {
                TextField("What to ask next…", text: $appState.nextStepDraft, axis: .vertical)
                    .textFieldStyle(.roundedBorder).lineLimit(1 ... 4)
                if let hint = appState.continuationEngine.hint {
                    Text(hint).font(.caption).foregroundStyle(.secondary)
                }
            }

            if hasContext {
                DisclosureGroup(showContext ? "Hide Context" : "Show the Full Handoff", isExpanded: $showContext) {
                    VStack(alignment: .leading, spacing: 10) {
                        if !packet.decisions.isEmpty {
                            labeled("You’d Established") {
                                ForEach(packet.decisions) { d in
                                    Text(d.statement).fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }
                        if let shift = packet.thinkingShift, !shift.isEmpty {
                            labeled("How Your Thinking Changed") {
                                Text(shift).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        if let q = contested {
                            labeled("You Hadn’t Resolved") {
                                Text(q).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .padding(.top, 4)
                }
            }

            HStack {
                Spacer()
                // The standard macOS share sheet: Messages, Mail, Notes, AirDrop, any share extension.
                if let text = appState.continuationCopyText {
                    ShareLink(item: text) { Text("Share…") }
                        .buttonStyle(.borderless)
                        .help("Send this handoff to Messages, Mail, Notes, or another app")
                }
                Button("Copy") { appState.recopyContinuation() }
                    .keyboardShortcut("c", modifiers: [.command, .shift])
                    .help("Copy the handoff (⇧⌘C)")
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private var handoffStatus: some View {
        switch appState.handoff {
        case .placedNatively(let tool):
            Label("Added to \(tool.label). Review and send", systemImage: "checkmark.circle").foregroundStyle(.green)
        case .readyToPaste(let tool):
            Label("\(tool.label) ready. Press ⌘V", systemImage: "checkmark.circle").foregroundStyle(.green)
        case .draftInTheWay(let tool):
            Label("\(tool.label) has an unsent draft. Clear it, then ⌘V", systemImage: "exclamationmark.circle")
                .foregroundStyle(.secondary)
        case .copied:
            Label("Copied. Press ⌘V in your AI app", systemImage: "checkmark.circle").foregroundStyle(.green)
        case .none:
            if appState.continueCopied { Label("Copied", systemImage: "checkmark.circle").foregroundStyle(.green) }
        }
    }

    private func labeled<Content: View>(_ label: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
            content()
        }
    }

    /// The wider claim this idea belongs to (the Minto-style synthesis), unlabeled by design.
    private func governingThoughtBlock(_ governing: GoverningThought) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(governing.statement).font(.headline).fixedSize(horizontal: false, vertical: true)
            if !governing.members.isEmpty {
                Text(governing.kind.capitalized).font(.caption).foregroundStyle(.secondary)
                ForEach(governing.members) { member in
                    Button { Task { await appState.openIdea(member.id) } } label: {
                        Text(cleanIdeaTitle(member.title, fallback: member.currentFormulation))
                            .multilineTextAlignment(.leading)
                    }
                    .buttonStyle(.link)
                }
            }
        }
    }
}
