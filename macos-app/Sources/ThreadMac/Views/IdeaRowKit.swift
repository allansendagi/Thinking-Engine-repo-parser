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

extension IdeaRow {
    /// What VoiceOver reads for the row, as one sentence: the idea, what it says, where and when it
    /// was last worked on, and what state it is in (the circle's meaning, which is otherwise only
    /// visible).
    func spokenDescription(showSnippet: Bool) -> String {
        var parts = [title]
        if showSnippet, let s = snippet, !s.isEmpty { parts.append(s) }
        if !meta.isEmpty { parts.append(meta) }
        if isLoop {
            parts.append("Open question")
        } else {
            switch status {
            case .openQuestion: parts.append("Has an open question")
            case .contested: parts.append("Contested")
            case .established: parts.append("Settled")
            case .rejected: parts.append("Set aside")
            case .neutral: break
            }
        }
        return parts.joined(separator: ". ")
    }
}

extension View {
    /// Makes a tappable row a single VoiceOver button: one spoken sentence, selected state, and the
    /// same action as a click. (Rows are tap gestures, which VoiceOver can't activate on its own.)
    func rowAccessibility(_ row: IdeaRow, selected: Bool, showSnippet: Bool, action: @escaping () -> Void) -> some View {
        accessibilityElement(children: .ignore)
            .accessibilityLabel(row.spokenDescription(showSnippet: showSnippet))
            .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
            .accessibilityAction(.default, action)
    }
}

struct IdeaRowGroup: Identifiable {
    let id: String
    let label: String
    let rows: [IdeaRow]
    /// Set when this group is one idea's questions inside a named section (e.g. "Open questions"):
    /// the section's heading shows once, above the first such group, and `label` is the idea's name.
    var section: String? = nil
    var leadsSection = false
}

/// The "Open questions" section on the Recent tab. The same rule the Open loops tab uses: while every idea
/// has at most one question the list stays flat (each row names its idea); once any idea has two or
/// more, the questions are grouped under that idea's name, shown once, so the same title isn't
/// printed under every question and several questions from one idea read as a set.
/// Order is the server's (it ranks what to resurface); ideas appear where their first question does.
func revisitGroups(_ revisit: [ThinkingStateResponse.Revisit], section: String = "Open questions") -> [IdeaRowGroup] {
    guard !revisit.isEmpty else { return [] }

    func row(_ r: ThinkingStateResponse.Revisit, showIdea: Bool) -> IdeaRow {
        let why = r.via.map { "Back on it via \(cleanIdeaTitle($0, fallback: $0))" }
        let source = why ?? (showIdea ? cleanIdeaTitle(r.ideaTitle, fallback: r.ideaTitle) : nil)
        return IdeaRow(
            id: "loop:" + r.loopId,
            title: deNarrate(r.statement.trimmingCharacters(in: .whitespaces)),
            snippet: nil, meta: metaLine(source, r.raisedAt),
            isLoop: true, ideaId: r.ideaId, when: r.raisedAt
        )
    }

    var order: [String] = []
    var byIdea: [String: [ThinkingStateResponse.Revisit]] = [:]
    for r in revisit {
        if byIdea[r.ideaId] == nil { order.append(r.ideaId) }
        byIdea[r.ideaId, default: []].append(r)
    }

    if !byIdea.values.contains(where: { $0.count >= 2 }) {
        return [IdeaRowGroup(id: "revisit", label: section, rows: revisit.map { row($0, showIdea: true) })]
    }
    return order.enumerated().map { i, id in
        let rs = byIdea[id] ?? []
        return IdeaRowGroup(
            id: "revisit:" + id,
            label: cleanIdeaTitle(rs.first?.ideaTitle ?? "", fallback: rs.first?.ideaTitle ?? "Untitled"),
            rows: rs.map { row($0, showIdea: false) },
            section: section, leadsSection: i == 0
        )
    }
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

/// Pinned ideas first, as their own "Pinned" group, then everything else by date. The single place
/// that decides where a pin shows, so the panel's Recent and All lists and the main window agree.
func pinnedThenDated(_ rows: [IdeaRow], isPinned: (String) -> Bool) -> [IdeaRowGroup] {
    let pinned = rows.filter { isPinned($0.ideaId) }.sorted { $0.when > $1.when }
    let rest = rows.filter { !isPinned($0.ideaId) }
    let lead = pinned.isEmpty ? [] : [IdeaRowGroup(id: "pinned", label: "Pinned", rows: pinned)]
    return lead + dateBucketedGroups(rest)
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
/// An idea's name above its questions, inside a named section: quieter than a section heading.
struct IdeaGroupHeading: View {
    let label: String
    let count: Int

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).font(.subheadline.weight(.medium)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 8)
            if count > 1 { Text("\(count) questions").font(.footnote).foregroundStyle(.tertiary) }
        }
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.stickyTint)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

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
