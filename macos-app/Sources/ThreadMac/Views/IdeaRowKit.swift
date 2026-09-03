import SwiftUI

/// Shared list vocabulary for both surfaces: the menu-bar panel (MenuBarListView) and the full
/// window (MainWindowView). One row look, one title-cleanup rule, one grouping — so the wide
/// window is the panel with room to breathe, not a second design.

/// Strips third-person narration the extractor still sometimes emits ("The user is asking why…")
/// so a row title reads as the thought itself.
func deNarrate(_ s: String) -> String {
    let ps = [
        "The user is asking why ", "The user is asking whether ", "The user is asking what ",
        "The user is asking how ", "The user is asking for ", "The user is asking ",
        "The user is questioning ", "The user is seeking ", "The user is proposing ",
        "The user is claiming ", "The user decides to ", "The user claims ", "The user wants to ",
        "The human is asking why ", "The human is asking whether ", "The human is asking ",
        "The human is questioning ", "The assistant is ", "The user is ", "The human is ",
    ]
    for p in ps where s.lowercased().hasPrefix(p.lowercased()) {
        let r = String(s.dropFirst(p.count))
        return r.prefix(1).capitalized + r.dropFirst()
    }
    return s
}

/// A row title, de-narrated. If the model only gave a truncated/empty title, fall back to the
/// first sentence of the current formulation.
func cleanIdeaTitle(_ title: String, fallback: String) -> String {
    let t = deNarrate(title.trimmingCharacters(in: .whitespaces))
    if t.isEmpty || t.hasSuffix("…") || t.hasSuffix("...") {
        let c = fallback.split(whereSeparator: { ".?!".contains($0) }).first.map(String.init) ?? fallback
        return deNarrate(c.trimmingCharacters(in: .whitespaces))
    }
    return t
}

/// The formulation is only worth showing as a second line when it says more than the title
/// already does -- otherwise the row just prints the same sentence twice.
func rowSnippet(title: String, formulation: String) -> String? {
    let f = formulation.trimmingCharacters(in: .whitespacesAndNewlines)
    let t = title.trimmingCharacters(in: CharacterSet(charactersIn: " ….,"))
    guard !f.isEmpty else { return nil }
    guard !t.isEmpty else { return f }
    let fl = f.lowercased(), tl = t.lowercased()
    if fl == tl || fl.hasPrefix(tl) || tl.hasPrefix(fl) { return nil }
    return f
}

/// The one quiet, fully-derived state a row carries — read straight off the idea, never
/// user-set. Its whole expression is the leading glyph (see `IdeaRowView.glyphSymbol`): a calm
/// circle family, empty → dotted → full, with contested the only one that breaks family
/// because it's the only one that means *do something now*.
enum RowStatus {
    case neutral       // developing / dormant, nothing pending -> hollow circle
    case openQuestion  // has an unresolved open loop           -> dotted circle
    case contested     // idea state is contested               -> amber half-filled circle
    case established    // a decision settled it                 -> filled circle, dimmed
    case rejected      // set aside                              -> slashed circle, dimmed
}

/// The marker for a raw, user-settable idea state. Same circle family as the list rows, so the
/// State picker, the detail eyebrow, and the Help legend all speak one visual language — the way
/// a flag colour or a priority dot reads the same everywhere in an Apple app.
enum IdeaStatus {
    static func symbol(_ state: String) -> String {
        switch state {
        case "established": return "circle.fill"
        case "contested":   return "circle.bottomhalf.filled"
        case "rejected":    return "circle.slash"
        case "dormant":     return "circle.dashed"
        default:            return "circle"   // developing
        }
    }
    /// Amber for contested (the one that means act now); everything else is quiet.
    static func tint(_ state: String) -> Color {
        state == "contested" ? Theme.stateColor("contested") : .secondary
    }
}

/// Priority when several could apply: contested > openQuestion > rejected > established.
/// Loops are always drawn as `.openQuestion` — a loop row *is* the question.
func rowStatus(state: String?, hasOpenLoop: Bool) -> RowStatus {
    if state == "contested" { return .contested }
    if hasOpenLoop { return .openQuestion }
    if state == "rejected" { return .rejected }
    if state == "established" { return .established }
    return .neutral
}

struct IdeaRow: Identifiable {
    let id: String
    let title: String
    let snippet: String?
    let meta: String
    let isLoop: Bool
    let ideaId: String
    let when: String
    var status: RowStatus = .neutral
}

struct IdeaRowGroup: Identifiable {
    let id: String
    let label: String
    let rows: [IdeaRow]
}

/// "ChatGPT · 24m ago" — source + relative time. Falls back to just one, or "".
func metaLine(_ source: String?, _ when: String) -> String {
    let time = Theme.ago(when)
    switch (source, time.isEmpty) {
    case let (label?, false): return "\(label) · \(time)"
    case let (label?, true): return label
    case (nil, false): return time
    case (nil, true): return ""
    }
}

/// Open loops get ONE layout mode at a time — never a mix.
///
/// While every idea carries at most one open loop, the flat list is clearest: each loop is its
/// own row with the parent thought as the secondary line. The moment any single idea has two or
/// more open loops, the whole screen switches to grouping by parent thought, so you can see
/// *why* several similar questions coexist. The data already supports this — every loop knows
/// its `ideaId` and `ideaTitle`.
///
/// `flatLabel` is the section title in flat mode (the two surfaces name it differently).
/// `sourceLabelFor` / `whenFor` are optional per-ideaId fallbacks the panel supplies for loops
/// whose own `latestSource` / `createdAt` are absent (older backend payloads).
func openLoopGroups(
    _ loops: [ThinkingStateResponse.OpenLoopEntry],
    flatLabel: String,
    sourceLabelFor: (String) -> String? = { _ in nil },
    whenFor: (String) -> String? = { _ in nil }
) -> [IdeaRowGroup] {
    let active = loops.filter { !$0.resolved }
    guard !active.isEmpty else { return [] }

    func when(_ l: ThinkingStateResponse.OpenLoopEntry) -> String {
        l.createdAt ?? whenFor(l.ideaId) ?? ""
    }
    func row(_ l: ThinkingStateResponse.OpenLoopEntry, showParent: Bool) -> IdeaRow {
        IdeaRow(
            id: "loop:" + l.loopId,
            title: deNarrate(l.statement.trimmingCharacters(in: .whitespaces)),
            snippet: showParent ? l.ideaTitle : nil,
            meta: metaLine(l.sourceLabel ?? sourceLabelFor(l.ideaId), when(l)),
            isLoop: true, ideaId: l.ideaId, when: when(l)
        )
    }

    var byIdea: [String: [ThinkingStateResponse.OpenLoopEntry]] = [:]
    var seenOrder: [String] = []
    for l in active {
        if byIdea[l.ideaId] == nil { seenOrder.append(l.ideaId) }
        byIdea[l.ideaId, default: []].append(l)
    }

    // Flat mode: one idea per loop. Newest loop first; parent thought on the second line.
    if !byIdea.values.contains(where: { $0.count >= 2 }) {
        let rows = active.sorted { when($0) > when($1) }.map { row($0, showParent: true) }
        return [IdeaRowGroup(id: "loops", label: flatLabel, rows: rows)]
    }

    // Grouped mode: one section per parent thought, ordered by its most recent loop.
    let parents = seenOrder.sorted { a, b in
        let am = byIdea[a]?.map(when).max() ?? ""
        let bm = byIdea[b]?.map(when).max() ?? ""
        return am > bm
    }
    return parents.map { id in
        let ls = (byIdea[id] ?? []).sorted { when($0) > when($1) }
        return IdeaRowGroup(
            id: "idea:" + id,
            label: ls.first?.ideaTitle ?? "Untitled",
            rows: ls.map { row($0, showParent: false) }
        )
    }
}

/// Buckets rows into Today / Yesterday / This week / … (newest bucket first, newest row first).
func dateBucketedGroups(_ rows: [IdeaRow]) -> [IdeaRowGroup] {
    var buckets: [Int: (String, [IdeaRow])] = [:]
    for r in rows {
        let b: (order: Int, label: String) = r.when.isEmpty ? (4, "Earlier") : Theme.bucket(r.when)
        buckets[b.order, default: (b.label, [])].1.append(r)
    }
    return buckets.keys.sorted().map { k in
        let (label, rs) = buckets[k]!
        return IdeaRowGroup(id: "b\(k)", label: label, rows: rs.sorted { $0.when > $1.when })
    }
}

/// The one row. Density and whether the snippet line shows are user preferences
/// (Settings ▸ Appearance), read live from AppState so both surfaces stay in sync.
struct IdeaRowView: View {
    let row: IdeaRow
    let selected: Bool
    @EnvironmentObject private var appState: AppState
    @State private var hover = false

    private var d: Density { appState.density }

    /// The row's whole state expression: one circle-family SF Symbol.
    private var glyphSymbol: String {
        if row.isLoop { return "circle.dotted" }
        switch row.status {
        case .contested:    return "circle.bottomhalf.filled"
        case .openQuestion: return "circle.dotted"
        case .established:  return "circle.fill"
        case .rejected:     return "circle.slash"
        case .neutral:      return "circle"
        }
    }
    private var glyphDimmed: Bool {
        !selected && (row.status == .established || row.status == .rejected)
    }
    private var glyphColor: Color {
        if selected { return Theme.onAccent(0.9) }
        if row.status == .contested { return Theme.stateColor("contested") }
        return Theme.ink(glyphDimmed ? 0.3 : 0.42)
    }

    var body: some View {
        HStack(alignment: .top, spacing: d.hSpacing) {
            Image(systemName: glyphSymbol)
                .font(.system(size: d.glyphSize - 2, weight: .regular))
                .foregroundStyle(glyphColor)
                .frame(width: 16).padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title)
                    .font(.system(size: d.titleSize, weight: .medium)).kerning(-0.08)
                    .lineSpacing(1.5).lineLimit(2)
                    .foregroundStyle(selected ? Color.white : Theme.ink(0.87))
                if appState.showSnippets, let s = row.snippet, !s.isEmpty {
                    Text(s).font(.system(size: d.bodySize)).lineSpacing(1).lineLimit(2)
                        .foregroundStyle(selected ? Theme.onAccent(0.82) : Theme.ink(0.5))
                }
                if !row.meta.isEmpty {
                    Text(row.meta).font(.system(size: 11))
                        .foregroundStyle(selected ? Theme.onAccent(0.72) : Theme.ink(0.36))
                        .padding(.top, 1)
                }
            }
        }
        .padding(d.rowPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 7)
                .fill(selected ? Theme.accent : (hover ? Theme.hoverFill : Color.clear))
        )
        .padding(.horizontal, 8).padding(.bottom, 1)
        .onHover { hover = $0 }
    }
}

/// The sticky "Today" / "Yesterday" section header, one style for both surfaces.
struct IdeaRowSectionHeader: View {
    let label: String
    var body: some View {
        Text(label)
            .font(.system(size: 12, weight: .semibold)).kerning(-0.12)
            .foregroundStyle(Theme.ink(0.85))
            .lineLimit(1).truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 5)
            .background(Theme.stickyTint)
    }
}
