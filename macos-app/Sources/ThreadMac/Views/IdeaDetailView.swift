import SwiftUI

struct IdeaDetailView: View {
    @EnvironmentObject var appState: AppState
    @State private var titleDraft = ""

    var body: some View {
        ScrollView {
            if let trace = appState.selectedTrace {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        TextField("Title", text: $titleDraft)
                            .textFieldStyle(.roundedBorder)
                            .onAppear { titleDraft = trace.idea.title }
                        Button("Save") { Task { await appState.renameSelected(to: titleDraft) } }
                    }

                    Text(trace.idea.currentFormulation)
                        .font(.callout)
                        .foregroundColor(.secondary)

                    Picker("State", selection: Binding(
                        get: { trace.idea.state },
                        set: { newValue in Task { await appState.setSelectedState(newValue) } }
                    )) {
                        ForEach(["developing", "established", "rejected", "dormant"], id: \.self) { Text($0) }
                    }
                    .pickerStyle(.menu)

                    HStack {
                        Button("Continue thinking") { Task { await appState.continueThinkingOnSelected() } }
                        Button("Delete", role: .destructive) { Task { await appState.deleteSelected() } }
                    }

                    if let continueResult = appState.continueResult {
                        Text(continueResult)
                            .font(.caption)
                            .padding(8)
                            .background(Color.gray.opacity(0.08))
                            .cornerRadius(6)
                    }

                    Text("EVOLUTION").font(.caption2).foregroundColor(.secondary).padding(.top, 6)
                    ForEach(trace.provenance) { step in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(step.formulation).font(.caption)
                            if let sourceText = step.sourceText {
                                Text("grounded in: \"\(sourceText.prefix(80))\"")
                                    .font(.caption2)
                                    .foregroundColor(.secondary)
                            }
                        }
                        .padding(.leading, 8)
                        .overlay(Rectangle().frame(width: 2).foregroundColor(.gray.opacity(0.3)), alignment: .leading)
                    }

                    Text("OPEN LOOPS").font(.caption2).foregroundColor(.secondary).padding(.top, 6)
                    if trace.idea.openLoops.isEmpty {
                        Text("None.").font(.caption).foregroundColor(.secondary)
                    } else {
                        ForEach(trace.idea.openLoops) { loop in
                            HStack {
                                Text(loop.statement)
                                    .font(.caption)
                                    .strikethrough(loop.resolved)
                                Spacer()
                                Toggle("", isOn: Binding(
                                    get: { loop.resolved },
                                    set: { newValue in Task { await appState.toggleLoop(loop.id, resolved: newValue) } }
                                ))
                                .labelsHidden()
                            }
                        }
                    }
                }
                .padding(10)
            } else {
                ProgressView().padding(20)
            }
        }
    }
}
