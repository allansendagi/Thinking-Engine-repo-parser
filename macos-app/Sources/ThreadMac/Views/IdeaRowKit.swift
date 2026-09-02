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

struct IdeaRow: Identifiable {
    let id: String
    let title: String
    let snippet: String?
    let meta: String
    let isLoop: Bool
    let ideaId: String
    let when: String
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

    var body: some View {
        HStack(alignment: .top, spacing: d.hSpacing) {
            Glyph(kind: row.isLoop ? .loop : .idea, size: d.glyphSize)
                .foregroundStyle(selected ? Theme.onAccent(0.9) : Theme.ink(0.42))
                .frame(width: 16).padding(.top, 1)
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
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 5)
            .background(Theme.stickyTint)
    }
}
