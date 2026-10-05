import CoreSpotlight
import Foundation
import UniformTypeIdentifiers

/// Ideas in Spotlight: ⌘Space, type a few words, and your own thinking shows up next to apps and
/// files. Indexed on this Mac only (Core Spotlight's private on-device index), refreshed whenever
/// the graph changes, removed on sign-out, and switchable off in Settings. Choosing a result opens
/// the idea in the recall panel (see AppDelegate `continue userActivity`).
enum SpotlightIndex {
    static let domain = "com.thread.mac.ideas"
    private static let enabledKey = "thread.spotlightEnabled"

    /// On unless the user turned it off.
    static var isEnabled: Bool {
        get { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: enabledKey)
            if !newValue { removeAll() }
        }
    }

    /// Make the index match `ideas` exactly: replace the whole domain, so renamed or deleted ideas
    /// never linger as stale results.
    static func sync(_ ideas: [IdeaSummary]) {
        guard isEnabled, CSSearchableIndex.isIndexingAvailable() else { return }
        let items = ideas.map(item(for:))
        let index = CSSearchableIndex.default()
        index.deleteSearchableItems(withDomainIdentifiers: [domain]) { _ in
            guard !items.isEmpty else { return }
            index.indexSearchableItems(items) { error in
                if let error { print("[ThreadMac] Spotlight indexing failed: \(error)") }
            }
        }
    }

    static func removeAll() {
        CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [domain]) { _ in }
    }

    /// The idea id from a Spotlight result the user chose, if that's what this activity is.
    static func ideaId(from activity: NSUserActivity) -> String? {
        guard activity.activityType == CSSearchableItemActionType else { return nil }
        return activity.userInfo?[CSSearchableItemActivityIdentifier] as? String
    }

    private static func item(for idea: IdeaSummary) -> CSSearchableItem {
        let attrs = CSSearchableItemAttributeSet(contentType: .text)
        attrs.title = idea.title
        attrs.contentDescription = idea.currentFormulation
        attrs.textContent = idea.currentFormulation
        attrs.keywords = ["Thread", "idea", idea.state] + (idea.sourceLabel.map { [$0] } ?? [])
        let item = CSSearchableItem(uniqueIdentifier: idea.id, domainIdentifier: domain, attributeSet: attrs)
        item.expirationDate = .distantFuture
        return item
    }
}
