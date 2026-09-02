import AppIntents
import AppKit

/// Native Shortcuts / Spotlight / Siri entry points. Each is a thin wrapper over the same
/// `AppState.perform(_:ThreadAction)` the `thread://` scheme and Services menu use — one
/// routing path, three surfaces. The discovery metadata bundle (`Metadata.appintents`) is
/// produced by `appintentsmetadataprocessor` in package.sh; SwiftPM has no build phase for it,
/// so the intents are invocable but only *discoverable* from a packaged build.

@MainActor
private func route(_ action: ThreadAction) {
    AppDelegate.shared?.appState.perform(action)
}

struct RecallInThreadIntent: AppIntent {
    static let title: LocalizedStringResource = "Recall in Thread"
    static let description = IntentDescription(
        "Open Thread's quick-recall panel and search your ideas for a phrase."
    )
    static let openAppWhenRun = true

    @Parameter(title: "Search", requestValueDialog: "What do you want to recall?")
    var query: String

    @MainActor
    func perform() async throws -> some IntentResult {
        route(.recall(query))
        return .result()
    }
}

struct ThreadOpenLoopsIntent: AppIntent {
    static let title: LocalizedStringResource = "Show Open Loops"
    static let description = IntentDescription(
        "Open Thread on the unresolved questions across your ideas."
    )
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        route(.openLoops)
        return .result()
    }
}

struct ContinueInThreadIntent: AppIntent {
    static let title: LocalizedStringResource = "Continue a Thought in Thread"
    static let description = IntentDescription(
        "Find the idea that best matches a topic and build a continuation handoff for it."
    )
    static let openAppWhenRun = true

    @Parameter(title: "Topic", requestValueDialog: "Which thought do you want to continue?")
    var topic: String

    @MainActor
    func perform() async throws -> some IntentResult {
        route(.continueTopic(topic))
        return .result()
    }
}

struct ThreadShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: RecallInThreadIntent(),
            phrases: [
                "Recall \(\.$query) in \(.applicationName)",
                "Recall in \(.applicationName)",
            ],
            shortTitle: "Recall",
            systemImageName: "magnifyingglass"
        )
        AppShortcut(
            intent: ThreadOpenLoopsIntent(),
            phrases: [
                "Show my open loops in \(.applicationName)",
                "\(.applicationName) open loops",
            ],
            shortTitle: "Open Loops",
            systemImageName: "circle.dashed"
        )
        AppShortcut(
            intent: ContinueInThreadIntent(),
            phrases: [
                "Continue \(\.$topic) in \(.applicationName)",
                "Continue a thought in \(.applicationName)",
            ],
            shortTitle: "Continue",
            systemImageName: "arrow.uturn.forward"
        )
    }
}
