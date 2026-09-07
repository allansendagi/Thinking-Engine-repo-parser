import Foundation

#if canImport(ApplicationServices) && canImport(AppKit)
import ApplicationServices
import AppKit

/// What the sensor can tell the rest of the app about itself -- feeds the same "is capture
/// actually working" story as `/v1/capture-health` does for the extension.
enum AXSensorStatus: Equatable {
    case idle                 // not started
    case needsPermission      // Accessibility not granted to this app
    case appNotRunning        // the target app isn't open
    case watching(pid: pid_t) // observer installed, listening
    case error(String)
}

/// The live driver: turns Accessibility notifications from one running app into `ingestConversation`
/// calls. Observer-driven, no polling loop -- a burst of notifications is debounced into a single
/// tree scan. Nothing here runs in CI (no permission, no target app); it is covered by the manual
/// harness described in the M4 PR. The scan/diff/settle logic it calls (`AXConversationSensor`) is
/// what the unit tests cover.
@MainActor
final class AXSensorRunner {
    private let adapter: any AXConversationAdapter
    private let bundleID: String
    private let source: String
    private let ingest: (_ id: String, _ messages: [(id: String, role: String, text: String, createdAt: String)], _ fidelity: String) async -> Void

    private var observer: AXObserver?
    private var appElement: AXUIElement?
    private var state = AXSensorState()
    private var debounce: DispatchWorkItem?
    private let iso = ISO8601DateFormatter()

    private(set) var status: AXSensorStatus = .idle {
        didSet { if status != oldValue { onStatusChange?(status) } }
    }
    var onStatusChange: ((AXSensorStatus) -> Void)?

    /// `ingest` is injected so this class never imports the API client directly -- the app wires
    /// it to `APIClient.ingestConversation(..., capture: ("native_accessibility", fidelity))`.
    init(
        adapter: any AXConversationAdapter,
        bundleID: String,
        source: String = "cursor",
        ingest: @escaping (_ id: String, _ messages: [(id: String, role: String, text: String, createdAt: String)], _ fidelity: String) async -> Void
    ) {
        self.adapter = adapter
        self.bundleID = bundleID
        self.source = source
        self.ingest = ingest
    }

    // MARK: - Accessibility permission

    static var accessibilityGranted: Bool { AXIsProcessTrusted() }

    /// Prompts once (macOS shows the System Settings deep-link). Returns the current grant state.
    @discardableResult
    static func requestAccessibility() -> Bool {
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(opts)
    }

    // MARK: - lifecycle

    func start() {
        guard Self.accessibilityGranted else { status = .needsPermission; return }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first else {
            status = .appNotRunning
            return
        }
        let pid = app.processIdentifier
        let el = AXUIElementCreateApplication(pid)
        appElement = el

        var obs: AXObserver?
        let err = AXObserverCreate(pid, axSensorCallback, &obs)
        guard err == .success, let obs else { status = .error("AXObserverCreate failed (\(err.rawValue))"); return }
        observer = obs

        let ctx = Unmanaged.passUnretained(self).toOpaque()
        for note in [
            kAXValueChangedNotification,
            kAXCreatedNotification,
            kAXUIElementDestroyedNotification,
            kAXLayoutChangedNotification,
            kAXFocusedUIElementChangedNotification,
        ] {
            AXObserverAddNotification(obs, el, note as CFString, ctx)
        }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(obs), .defaultMode)
        status = .watching(pid: pid)

        scanSoon()  // one scan for whatever is already on screen
    }

    func stop() {
        debounce?.cancel(); debounce = nil
        if let obs = observer, let el = appElement {
            for note in [
                kAXValueChangedNotification, kAXCreatedNotification, kAXUIElementDestroyedNotification,
                kAXLayoutChangedNotification, kAXFocusedUIElementChangedNotification,
            ] {
                AXObserverRemoveNotification(obs, el, note as CFString)
            }
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(obs), .defaultMode)
        }
        observer = nil
        appElement = nil
        status = .idle
    }

    // MARK: - scan

    /// Called from the C callback. Coalesce a notification burst into one scan ~400ms after it
    /// goes quiet, so a streaming answer isn't scanned on every token.
    fileprivate func scanSoon() {
        debounce?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.scan() }
        debounce = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
    }

    private func scan() {
        guard let appElement else { return }
        let appRoot = LiveAXNode(appElement)
        guard let root = adapter.conversationRoot(appRoot: appRoot) else { return }
        guard let key = adapter.conversationKey(root: root, appRoot: appRoot) else { return }
        let blocks = adapter.messageBlocks(root: root)
        guard !blocks.isEmpty else { return }

        let step = AXConversationSensor.step(
            observation: .init(conversationKey: key, blocks: blocks),
            now: Date(),
            state: &state
        )
        guard !step.settled.isEmpty else { return }

        let conversationID = "\(source)::ax::\(key)"
        let base = Date()
        let messages = step.settled.enumerated().map { i, m in
            (id: m.id, role: m.role, text: m.text,
             createdAt: iso.string(from: base.addingTimeInterval(Double(i))))
        }
        let fidelity = AXConversationSensor.batchFidelity(step.settled)
        Task { @MainActor [ingest] in await ingest(conversationID, messages, fidelity) }
    }
}

/// Free C callback -- `AXObserver` can't call a Swift method directly. `refcon` is the runner.
private func axSensorCallback(
    _ observer: AXObserver,
    _ element: AXUIElement,
    _ notification: CFString,
    _ refcon: UnsafeMutableRawPointer?
) {
    guard let refcon else { return }
    let runner = Unmanaged<AXSensorRunner>.fromOpaque(refcon).takeUnretainedValue()
    Task { @MainActor in runner.scanSoon() }
}
#endif
