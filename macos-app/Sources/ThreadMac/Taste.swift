import Foundation

/// What Thread has learned about which ideas THIS person keeps (GET /v1/taste). "Is this worth
/// having?" is a judgment about one person, not a property of the text, so Thread proposes and the
/// person confirms: Keep / Not an idea, one click, and it gets better at proposing.
///
/// Taste SORTS, it never deletes: ideas it thinks are unlikely wait in a recoverable "Maybe" tray.
/// An explicit Keep always wins.
enum TasteTier: String, Codable, Equatable {
    case confirmed, likely, unsure, unlikely, suggested

    /// A tier this build doesn't know (a newer backend) is just a suggestion, never an error.
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TasteTier(rawValue: raw) ?? .suggested
    }
}

struct TasteIdea: Codable, Equatable {
    let ideaId: String
    let tier: TasteTier
}

struct TasteReport: Codable, Equatable {
    /// Enough Keeps AND Not-an-ideas that Thread trusts its guess.
    let ready: Bool
    let keeps: Int
    let notIdeas: Int
    /// Share of the last `window` verdicts that were Keep -- how well Thread's proposals fit.
    let acceptanceRate: Double?
    /// How many verdicts the rate is over. Optional: older backends don't send it.
    var acceptanceSample: Int?
    let window: Int
    let ideas: [TasteIdea]
}

/// The ideas to hold in the Maybe tray: taste says "unlikely", and the person hasn't said Keep.
/// Pure, so the rule is testable. A Keep made on this Mac (still queued) counts immediately.
func maybeIdeaIDs(report: TasteReport?, pendingEdits: [PendingEdit]) -> Set<String> {
    guard let report, report.ready else { return [] }
    let keptHere = Set(pendingEdits.compactMap { e -> String? in
        if case .keep = e.kind { return e.ideaId }
        return nil
    })
    return Set(report.ideas.filter { $0.tier == .unlikely && !keptHere.contains($0.ideaId) }.map(\.ideaId))
}

/// True when the person has said Keep -- on the server, or here and not yet synced.
func isConfirmedIdea(_ ideaId: String, report: TasteReport?, pendingEdits: [PendingEdit]) -> Bool {
    if pendingEdits.contains(where: { if case .keep = $0.kind { return $0.ideaId == ideaId }; return false }) { return true }
    return report?.ideas.first(where: { $0.ideaId == ideaId })?.tier == .confirmed
}

extension AppState {
    /// Best-effort: an older backend, or being offline, just leaves everything as a suggestion.
    func refreshTaste() async {
        guard isPaired else { return }
        if let report = try? await client.getTaste() { taste = report }
    }

    var maybeIdeaIds: Set<String> { maybeIdeaIDs(report: taste, pendingEdits: pendingEdits) }

    func isConfirmed(_ ideaId: String) -> Bool {
        isConfirmedIdea(ideaId, report: taste, pendingEdits: pendingEdits)
    }
}
