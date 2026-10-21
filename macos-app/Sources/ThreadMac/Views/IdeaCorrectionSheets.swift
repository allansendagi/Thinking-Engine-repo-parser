import SwiftUI

/// Which correction sheet is open, and for which idea.
enum IdeaCorrection: Identifiable {
    case merge(ideaId: String)
    case split(ideaId: String)
    var id: String {
        switch self {
        case .merge(let i): return "merge:\(i)"
        case .split(let i): return "split:\(i)"
        }
    }
}

/// A split moves some of an idea's thoughts out, never none and never all of them.
enum SplitSelection {
    static func isValid(selected: Int, total: Int) -> Bool { selected >= 1 && selected <= total - 1 }
}

/// "Merge Into…": pick the idea this one really belongs to. Searchable list, Cancel / Merge.
struct MergeIdeaSheet: View {
    let ideaId: String
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var choice: String?
    @State private var working = false

    private var title: String { appState.selectedTrace?.idea.title ?? "this idea" }
    private var candidates: [IdeaSummary] {
        let all = appState.mergeCandidates(for: ideaId)
        let q = query.trimmingCharacters(in: .whitespaces)
        return q.isEmpty ? all : all.filter { $0.title.localizedCaseInsensitiveContains(q) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Merge Into…").font(.headline)
            Text("Everything in “\(title)” moves into the idea you pick. Thread remembers they are one idea.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            TextField("Search ideas", text: $query).textFieldStyle(.roundedBorder)
            List(candidates, selection: $choice) { idea in
                Text(cleanIdeaTitle(idea.title, fallback: idea.currentFormulation)).tag(idea.id as String?)
            }
            .frame(minHeight: 180)
            .overlay { if candidates.isEmpty { Text("No matching ideas").foregroundStyle(.secondary) } }
            HStack {
                if working { ProgressView().controlSize(.small) }
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Merge") {
                    guard let target = choice else { return }
                    working = true
                    Task {
                        let ok = await appState.mergeIdea(ideaId, into: target)
                        working = false
                        if ok { dismiss() }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(choice == nil || working)
            }
        }
        .padding(20).frame(width: 420)
    }
}

/// "Split…": tick the thoughts that belong to a different idea. At least one moves, at least one stays.
struct SplitIdeaSheet: View {
    let ideaId: String
    @EnvironmentObject var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var picked: Set<String> = []
    @State private var working = false

    private var thoughts: [EvolutionStep] { appState.selectedTrace?.idea.evolution ?? [] }
    private var splittable: [EvolutionStep] { thoughts.filter { $0.cognitiveEventId != nil } }
    private var valid: Bool { SplitSelection.isValid(selected: picked.count, total: splittable.count) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Split…").font(.headline)
            Text("Tick the thoughts that belong to a different idea. They move into an idea of their own; the rest stay.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            List {
                ForEach(splittable) { step in
                    Toggle(isOn: Binding(
                        get: { picked.contains(step.cognitiveEventId ?? "") },
                        set: { on in
                            guard let tid = step.cognitiveEventId else { return }
                            if on { picked.insert(tid) } else { picked.remove(tid) }
                        })) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(step.formulation).fixedSize(horizontal: false, vertical: true)
                            Text(Theme.ago(step.createdAt)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .toggleStyle(.checkbox)
                }
            }
            .frame(minHeight: 200)
            if !valid && !picked.isEmpty {
                Text("Leave at least one thought in this idea.").font(.footnote).foregroundStyle(.secondary)
            }
            HStack {
                if working { ProgressView().controlSize(.small) }
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Split") {
                    working = true
                    Task {
                        let ok = await appState.splitIdea(ideaId, thoughtIds: Array(picked))
                        working = false
                        if ok { dismiss() }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!valid || working)
            }
        }
        .padding(20).frame(width: 440)
    }
}

/// Sheet host shared by the panel and the main window.
struct IdeaCorrectionSheetHost: ViewModifier {
    @EnvironmentObject var appState: AppState
    func body(content: Content) -> some View {
        content.sheet(item: $appState.correction) { c in
            switch c {
            case .merge(let id): MergeIdeaSheet(ideaId: id).environmentObject(appState)
            case .split(let id): SplitIdeaSheet(ideaId: id).environmentObject(appState)
            }
        }
    }
}
extension View { func ideaCorrectionSheets() -> some View { modifier(IdeaCorrectionSheetHost()) } }
