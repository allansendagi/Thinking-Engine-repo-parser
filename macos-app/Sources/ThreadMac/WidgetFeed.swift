import Foundation
import WidgetKit

/// Keeps the Thread widget's snapshot current: your newest ideas and how many questions are open.
/// Off (Settings) removes the snapshot, so the widget goes back to its empty state.
enum WidgetFeed {
    private static let key = "thread.widget.enabled"
    static let maxIdeas = 6

    static var isEnabled: Bool {
        get { UserDefaults.standard.object(forKey: key) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }

    /// The snapshot for a thinking state: ideas by when they were last touched, newest first, minus the
    /// ones Thread isn't sure are yours (the Maybe tray), capped. Pure, so it is unit-tested.
    static func snapshot(from state: ThinkingStateResponse, excluding: Set<String> = [], now: Date = Date()) -> WidgetSnapshot {
        var touched: [String: Date] = [:]
        for c in state.recentChanges {
            guard let at = Theme.parse(c.createdAt) else { continue }
            if touched[c.ideaId].map({ $0 < at }) ?? true { touched[c.ideaId] = at }
        }
        let ideas = state.currentIdeas
            .filter { !excluding.contains($0.id) }
            .map { WidgetSnapshot.Idea(id: $0.id, title: cleanIdeaTitle($0.title, fallback: $0.currentFormulation), source: $0.sourceLabel, touched: touched[$0.id]) }
            .sorted { ($0.touched ?? .distantPast) > ($1.touched ?? .distantPast) }
        return WidgetSnapshot(
            updatedAt: now,
            ideas: Array(ideas.prefix(maxIdeas)),
            openLoops: state.openLoops.filter { !$0.resolved }.count
        )
    }

    /// Write (or clear) the snapshot and ask WidgetKit to redraw.
    @MainActor
    static func sync(state: ThinkingStateResponse?, excluding: Set<String>) {
        if isEnabled, let state {
            WidgetStore.save(snapshot(from: state, excluding: excluding))
        } else {
            WidgetStore.clear()
        }
        WidgetCenter.shared.reloadAllTimelines()
    }
}
