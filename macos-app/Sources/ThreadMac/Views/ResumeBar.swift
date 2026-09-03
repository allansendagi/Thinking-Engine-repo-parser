import SwiftUI

/// A single, high-confidence "you may be returning to this" candidate — the one restrained
/// nudge, never a feed. Derived from Thinking State (see `AppState.resumeSuggestion`).
struct ResumeSuggestion: Equatable {
    let ideaId: String
    let title: String
    let source: String?
    let daysAgo: Int
}

/// One idea considered for the resume nudge. Kept pure so the rule is testable on its own.
struct ResumeCandidate {
    let id: String
    let title: String        // already cleaned
    let state: String
    let source: String?
    let hasOpenLoop: Bool
    /// The unfinished thing is a logged contradiction (or the idea's state is contested) — the
    /// one signal that means *act now*, weighted well above a plain open question.
    let isContradiction: Bool
    let lastTouched: Date
}

/// How many times this idea's nudge has been shown, and the activity timestamp it was showing
/// against — so a fresh edit to the idea resets the count (new activity is new evidence).
struct ResumeShown: Equatable {
    var count: Int
    var sinceActivity: Date
}

// The nudge is a scored judgment, not a filter: every factor is in [0, 1], the score is their
// product, and it must clear `resumeConfidenceFloor` to show anything. Tuned to stay silent
// unless it's genuinely worth interrupting for — one wrong nudge costs more than ten missed ones.

let resumeConfidenceFloor = 0.5

/// Peaks a few days out (interrupted, still warm), decays to nothing by ~7 weeks.
func resumeRecencyWeight(ageDays: Double) -> Double {
    switch ageDays {
    case ..<1.5:    return 0.0                                   // still on it — a nudge is noise
    case 1.5..<3.5: return 0.2 + (ageDays - 1.5) / 2.0 * 0.8     // 0.2 → 1.0
    case 3.5...16:  return 1.0                                   // the sweet spot
    case 16...35:   return 1.0 - (ageDays - 16) / 19 * 0.6       // 1.0 → 0.4
    case 35...50:   return 0.4 - (ageDays - 35) / 15 * 0.4       // 0.4 → 0.0
    default:        return 0.0                                   // abandoned
    }
}

func resumeUnfinishedWeight(contradiction: Bool, openLoop: Bool) -> Double {
    if contradiction { return 1.0 }
    if openLoop { return 0.72 }
    return 0.0   // nothing unfinished — never a candidate
}

func resumeFatigueWeight(shownCount: Int) -> Double {
    switch shownCount {
    case ..<1: return 1.0
    case 1:    return 0.75
    case 2:    return 0.5
    default:   return 0.0   // offered enough times without a resume — it isn't live
    }
}

func scoreResumeCandidate(_ c: ResumeCandidate, shownCount: Int, now: Date) -> Double {
    let ageDays = now.timeIntervalSince(c.lastTouched) / 86_400
    return resumeRecencyWeight(ageDays: ageDays)
        * resumeUnfinishedWeight(contradiction: c.isContradiction || c.state == "contested",
                                 openLoop: c.hasOpenLoop)
        * resumeFatigueWeight(shownCount: shownCount)
}

/// The single idea worth resuming right now, or nil. Scores every eligible candidate, drops
/// anything snoozed or below the confidence floor, and stays quiet when the top two are close
/// enough that guessing which one you mean would be a coin flip.
func pickResumeSuggestion(
    _ candidates: [ResumeCandidate],
    snoozed: [String: Date],
    history: [String: ResumeShown] = [:],
    now: Date = Date()
) -> ResumeSuggestion? {
    let scored: [(c: ResumeCandidate, score: Double, age: Double)] = candidates.compactMap { c in
        guard c.state != "dormant", c.state != "rejected" else { return nil }
        if let s = snoozed[c.id], c.lastTouched <= s { return nil }   // snoozed since last activity
        let shown = history[c.id].flatMap { c.lastTouched <= $0.sinceActivity ? $0.count : 0 } ?? 0
        let score = scoreResumeCandidate(c, shownCount: shown, now: now)
        guard score > 0 else { return nil }
        return (c, score, now.timeIntervalSince(c.lastTouched) / 86_400)
    }
    .sorted { $0.score != $1.score ? $0.score > $1.score : $0.age < $1.age }

    guard let top = scored.first else { return nil }

    // If a second candidate is nearly as strong *and* nearly as recent, we don't actually know
    // which you're coming back to — say nothing rather than risk the wrong one.
    if scored.count > 1 {
        let second = scored[1]
        if top.score - second.score < 0.08, abs(top.age - second.age) < 2.5 { return nil }
    }

    guard top.score >= resumeConfidenceFloor else { return nil }

    return ResumeSuggestion(
        ideaId: top.c.id, title: top.c.title, source: top.c.source,
        daysAgo: max(1, Int(top.age.rounded()))
    )
}

/// The nudge row. Shows only at the top of the panel's Recent tab, only when a suggestion
/// exists. "Resume" builds the continuation packet; "Not now" snoozes it until the idea moves.
struct ResumeBar: View {
    let suggestion: ResumeSuggestion
    let onResume: () -> Void
    let onDismiss: () -> Void
    @State private var hover = false

    private var subtitle: String {
        let d = suggestion.daysAgo <= 1 ? "1 day ago" : "\(suggestion.daysAgo) days ago"
        if let s = suggestion.source { return "Last worked on in \(s), \(d)" }
        return "Last worked on \(d)"
    }

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(Theme.accent)
                .frame(width: 7, height: 7)
                .shadow(color: Theme.accent.opacity(0.55), radius: 4)

            VStack(alignment: .leading, spacing: 1) {
                Text("You may be returning to: \(suggestion.title)")
                    .font(.system(size: 12, weight: .medium)).kerning(-0.06)
                    .foregroundStyle(Theme.ink(0.85)).lineLimit(1)
                Text(subtitle)
                    .font(.system(size: 11)).foregroundStyle(Theme.ink(0.4)).lineLimit(1)
            }

            Spacer(minLength: 8)

            Button("Resume", action: onResume)
                .buttonStyle(.plain)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(Theme.accent)
            Button("Not now", action: onDismiss)
                .buttonStyle(.plain)
                .font(.system(size: 11.5))
                .foregroundStyle(Theme.ink(0.36))
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .background(
            RoundedRectangle(cornerRadius: 9)
                .fill(Theme.ink(hover ? 0.06 : 0.045))
        )
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(Theme.ink(0.09), lineWidth: 0.5))
        .padding(.horizontal, 12).padding(.bottom, 8)
        .onHover { hover = $0 }
        .transition(.opacity.combined(with: .move(edge: .top)))
    }
}
