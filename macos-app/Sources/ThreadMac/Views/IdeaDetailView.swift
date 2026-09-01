import SwiftUI

/// Hierarchy per the UI spec: current formulation is the headline, Continue is the primary
/// action, then evolution, then open loops. Editing (title, state, delete) is tucked into a menu.
struct IdeaDetailView: View {
    @EnvironmentObject var appState: AppState
    @State private var titleDraft = ""
    @State private var editingTitle = false

    private let states = ["developing", "established", "rejected", "dormant"]

    var body: some View {
        ScrollView {
            if let trace = appState.selectedTrace {
                VStack(alignment: .leading, spacing: 16) {
                    titleRow(trace)

                    Text(trace.idea.currentFormulation)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: false, vertical: true)

                    // Split button: click = recommended flow (copy + open preferred tool);
                    // the chevron opens the full menu.
                    Menu {
                        Button {
                            Task { await appState.continueThinking(sendTo: nil) }
                        } label: { Label("Copy context to clipboard", systemImage: "doc.on.clipboard") }
                        Divider()
                        ForEach(AppState.AITool.allCases) { tool in
                            Button {
                                Task { await appState.continueThinking(sendTo: tool) }
                            } label: {
                                Label(tool == .cursor ? "Copy for Cursor" : "Send to \(tool.label)",
                                      systemImage: tool == .cursor ? "curlybraces" : "arrow.up.forward.app")
                            }
                        }
                    } label: {
                        Label("Continue this idea", systemImage: "arrow.right.circle.fill")
                            .frame(maxWidth: .infinity)
                    } primaryAction: {
                        Task { await appState.continueThinking(sendTo: appState.preferredTool) }
                    }
                    .menuStyle(.borderlessButton)
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
                    .controlSize(.large)

                    if appState.continueResult != nil || appState.continueCopied {
                        VStack(alignment: .leading, spacing: 6) {
                            if let result = appState.continueResult {
                                Text(result)
                                    .font(.system(size: 12))
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            if let tool = appState.sentToTool {
                                Label("\(tool.label) opened · context ready — press ⌘V",
                                      systemImage: "checkmark.circle")
                                    .font(.system(size: 10)).foregroundStyle(Theme.accent)
                            } else if appState.continueCopied {
                                Label("Context copied to clipboard", systemImage: "checkmark.circle")
                                    .font(.system(size: 10)).foregroundStyle(Theme.accent)
                            }
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.cardFill)
                        .clipShape(RoundedRectangle(cornerRadius: Theme.cardCorner))
                    }

                    EvolutionTimeline(steps: trace.provenance)

                    if !trace.idea.relatedIdeaIds.isEmpty {
                        Text("Related: \(trace.idea.relatedIdeaIds.count) idea\(trace.idea.relatedIdeaIds.count == 1 ? "" : "s")")
                            .font(.system(size: 11)).foregroundStyle(.secondary)
                    }

                    section("Open loops") {
                        if trace.idea.openLoops.isEmpty {
                            Text("None open.").font(.system(size: 12)).foregroundStyle(.secondary)
                        } else {
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
                .padding(14)
            } else {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(30)
            }
        }
    }

    private func titleRow(_ trace: IdeaTrace) -> some View {
        HStack(spacing: 8) {
            if editingTitle {
                TextField("Title", text: $titleDraft)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit {
                        Task { await appState.renameSelected(to: titleDraft) }
                        editingTitle = false
                    }
                Button("Done") {
                    Task { await appState.renameSelected(to: titleDraft) }
                    editingTitle = false
                }
            } else {
                Text(trace.idea.title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Spacer()
                StatePill(state: trace.idea.state)
                Menu {
                    Button("Rename…") { titleDraft = trace.idea.title; editingTitle = true }
                    Picker("State", selection: Binding(
                        get: { trace.idea.state },
                        set: { s in Task { await appState.setSelectedState(s) } }
                    )) { ForEach(states, id: \.self) { Text($0.capitalized) } }
                    Divider()
                    Button("Delete idea", role: .destructive) { Task { await appState.deleteSelected() } }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
            }
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).sectionHeader()
            content()
        }
    }
}

/// Newest-first timeline. Consecutive steps from the same conversation are grouped under one
/// source header; the most recent step is the visually dominant one.
private struct EvolutionTimeline: View {
    let steps: [ProvenanceStep]

    private struct Group: Identifiable {
        let id = UUID()
        let source: String?
        let steps: [(step: ProvenanceStep, isCurrent: Bool)]
    }

    private var groups: [Group] {
        let ordered = Array(steps.enumerated().reversed()) // newest first
        var out: [Group] = []
        var bucket: [(ProvenanceStep, Bool)] = []
        var currentSource: String?? = nil
        for (idx, step) in ordered {
            let isCurrent = idx == steps.count - 1
            if currentSource == nil { currentSource = step.source }
            if step.source != currentSource {
                out.append(Group(source: currentSource ?? nil, steps: bucket.map { ($0.0, $0.1) }))
                bucket = []
                currentSource = step.source
            }
            bucket.append((step, isCurrent))
        }
        if !bucket.isEmpty { out.append(Group(source: currentSource ?? nil, steps: bucket.map { ($0.0, $0.1) })) }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Evolution").sectionHeader()
                Spacer()
                if steps.count > 1 {
                    Text("\(steps.count) steps").font(.system(size: 9)).foregroundStyle(.tertiary)
                }
            }

            VStack(alignment: .leading, spacing: 0) {
                ForEach(groups) { group in
                    if let label = ProvenanceStep(
                        formulation: "", createdAt: "", sourceText: nil, sourceRole: nil, source: group.source
                    ).sourceLabel {
                        Text(label)
                            .font(.system(size: 9, weight: .semibold)).textCase(.uppercase).kerning(0.4)
                            .foregroundStyle(.tertiary)
                            .padding(.leading, 14).padding(.top, 6).padding(.bottom, 2)
                    }
                    ForEach(Array(group.steps.enumerated()), id: \.offset) { _, entry in
                        row(entry.step, isCurrent: entry.isCurrent)
                    }
                }
            }
        }
    }

    private func row(_ step: ProvenanceStep, isCurrent: Bool) -> some View {
        HStack(alignment: .top, spacing: 9) {
            // rail
            VStack(spacing: 0) {
                Circle()
                    .fill(isCurrent ? Theme.accent : Color(nsColor: .tertiaryLabelColor))
                    .frame(width: isCurrent ? 7 : 5, height: isCurrent ? 7 : 5)
                    .padding(.top, isCurrent ? 3 : 4)
                Rectangle().fill(Theme.cardStroke).frame(width: 1).frame(maxHeight: .infinity)
            }
            .frame(width: 8)

            VStack(alignment: .leading, spacing: 2) {
                Text(Theme.relative(step.createdAt))
                    .font(.system(size: 9, design: .monospaced)).foregroundStyle(.tertiary)
                Text(step.formulation)
                    .font(.system(size: isCurrent ? 13 : 12, weight: isCurrent ? .medium : .regular))
                    .foregroundStyle(isCurrent ? .primary : .secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if isCurrent, let src = step.sourceText, !src.isEmpty {
                    Text("“\(src.prefix(100))\(src.count > 100 ? "…" : "")”")
                        .font(.system(size: 10)).foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.bottom, 10)
        }
    }
}
