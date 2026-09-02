import SwiftUI

/// A single, high-confidence "you may be returning to this" candidate — the one restrained
/// nudge, never a feed. Derived from Thinking State (see `AppState.resumeSuggestion`).
struct ResumeSuggestion: Equatable {
    let ideaId: String
    let title: String
    let source: String?
    let daysAgo: Int
}

/// One qualifying idea for the resume nudge. Kept pure so the rule is testable on its own.
struct ResumeCandidate {
    let id: String
    let title: String        // already cleaned
    let state: String
    let source: String?
    let hasOpenLoop: Bool
    let lastTouched: Date
}

/// The conservative rule: an idea qualifies only if it's genuinely unfinished (open loop or
/// contested), not dormant/rejected, last touched 3–45 days ago, and not snoozed since its last
/// activity. Returns the single most-recently-touched qualifier, or nil.
func pickResumeSuggestion(
    _ candidates: [ResumeCandidate],
    snoozed: [String: Date],
    now: Date = Date()
) -> ResumeSuggestion? {
    candidates
        .filter { c in
            guard c.state != "dormant", c.state != "rejected" else { return false }
            guard c.hasOpenLoop || c.state == "contested" else { return false }
            let ageDays = now.timeIntervalSince(c.lastTouched) / 86_400
            guard ageDays >= 3, ageDays <= 45 else { return false }
            if let s = snoozed[c.id], c.lastTouched <= s { return false }
            return true
        }
        .max { $0.lastTouched < $1.lastTouched }
        .map {
            ResumeSuggestion(
                ideaId: $0.id, title: $0.title, source: $0.source,
                daysAgo: Int((now.timeIntervalSince($0.lastTouched) / 86_400).rounded())
            )
        }
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
