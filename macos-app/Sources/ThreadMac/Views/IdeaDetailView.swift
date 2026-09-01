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

                    section("Evolution") {
                        if let origin = trace.provenance.first?.sourceLabel,
                           let latest = trace.provenance.last?.sourceLabel {
                            Text(latest == origin
                                 ? "Developed in \(latest)"
                                 : "Last developed in \(latest) · originally from \(origin)")
                                .font(.system(size: 10)).foregroundStyle(.tertiary)
                        }
                        // Newest first, matching the spec and the marketing site's recovery view.
                        ForEach(Array(trace.provenance.reversed())) { step in
                            HStack(alignment: .top, spacing: 9) {
                                Text(Theme.relative(step.createdAt))
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(.tertiary)
                                    .frame(width: 40, alignment: .leading)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(step.formulation).font(.system(size: 12))
                                        .fixedSize(horizontal: false, vertical: true)
                                    if let src = step.sourceText, !src.isEmpty {
                                        Text("“\(src.prefix(90))\(src.count > 90 ? "…" : "")”")
                                            .font(.system(size: 10)).foregroundStyle(.tertiary)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                }
                                Spacer(minLength: 6)
                                if let label = step.sourceLabel {
                                    Text(label).font(.system(size: 9)).foregroundStyle(.tertiary)
                                }
                            }
                        }
                    }

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
                Text(trace.idea.state)
                    .font(.system(size: 9, weight: .medium)).textCase(.uppercase).kerning(0.4)
                    .foregroundStyle(Theme.accent)
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
