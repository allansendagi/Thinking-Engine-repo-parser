import Foundation

#if canImport(ApplicationServices) && canImport(AppKit)
import ApplicationServices
import AppKit

/// What the sensor can tell the rest of the app about itself.
enum AXSensorStatus: Equatable {
    case idle                            // not started
    case needsPermission                 // Accessibility not granted to this app
    case waiting                         // started, but no supported AI app is running yet
    case watching(source: String, pid: pid_t) // observer installed on <source>'s app
    case error(String)
}

/// The live driver. Watches which native AI app is frontmost and points a single Accessibility
/// observer at it -- so capture follows the app the user is actually in. Observer-driven, no
/// polling loop; a notification burst is debounced into one tree scan. Nothing here runs in CI
/// (no permission, no target apps); it is the manual measurement rig. The scan/diff/settle logic
/// (`AXConversationSensor`) and the adapters are what the unit tests cover.
@MainActor
final class AXSensorRunner {
    private let adapters: [any AXConversationAdapter]
    /// (source, conversationId, messages, fidelity) -> ingest. Injected so this never imports the
    /// API client. `source` lets capture health track each app on its own.
    private let ingest: (_ source: String, _ id: String, _ messages: [(id: String, role: String, text: String, createdAt: String)], _ fidelity: String) async -> Void
    private let dumpTree = ProcessInfo.processInfo.environment["THREAD_AX_DUMP"] == "1"

    private var adapter: (any AXConversationAdapter)?
    private var observer: AXObserver?
    private var appElement: AXUIElement?
    private var watchedPID: pid_t?
    private var state = AXSensorState()
    private var debounce: DispatchWorkItem?
    private var tailSettle: DispatchWorkItem?
    private var activationObserver: NSObjectProtocol?
    private let iso = ISO8601DateFormatter()

    private(set) var status: AXSensorStatus = .idle {
        didSet { if status != oldValue { onStatusChange?(status) } }
    }
    var onStatusChange: ((AXSensorStatus) -> Void)?

    init(
        adapters: [any AXConversationAdapter],
        ingest: @escaping (_ source: String, _ id: String, _ messages: [(id: String, role: String, text: String, createdAt: String)], _ fidelity: String) async -> Void
    ) {
        self.adapters = adapters
        self.ingest = ingest
    }

    // MARK: - Accessibility permission

    static var accessibilityGranted: Bool { AXIsProcessTrusted() }

    @discardableResult
    static func requestAccessibility() -> Bool {
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(opts)
    }

    // MARK: - lifecycle

    func start() {
        guard Self.accessibilityGranted else { status = .needsPermission; return }

        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil
        ) { [weak self] note in
            guard
                let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                let bundleID = app.bundleIdentifier
            else { return }
            let pid = app.processIdentifier
            // The delivery thread isn't a MainActor guarantee -- hop explicitly, like the AX callback.
            Task { @MainActor in self?.considerApp(bundleID: bundleID, pid: pid) }
        }

        // Attach only if a supported app is genuinely frontmost. Otherwise wait -- letting app
        // activation drive every attach is what makes "which conversation is the user looking at"
        // true by construction, not by whatever order runningApplications happened to return.
        if let front = NSWorkspace.shared.frontmostApplication, let id = front.bundleIdentifier,
           AXAdapters.forBundleID(id) != nil {
            considerApp(bundleID: id, pid: front.processIdentifier)
        } else {
            status = .waiting
        }
    }

    func stop() {
        if let activationObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(activationObserver)
        }
        activationObserver = nil
        detach()
        status = .idle
    }

    // MARK: - app routing

    private func considerApp(bundleID: String, pid: pid_t) {
        guard let match = adapters.first(where: { $0.bundleIDs.contains(bundleID) }) else { return }
        if watchedPID == pid, adapter?.source == match.source { return } // already on it
        detach()
        attach(adapter: match, pid: pid)
    }

    private func attach(adapter: any AXConversationAdapter, pid: pid_t) {
        let el = AXUIElementCreateApplication(pid)
        var obs: AXObserver?
        guard AXObserverCreate(pid, axSensorCallback, &obs) == .success, let obs else {
            status = .error("AXObserverCreate failed")
            return
        }

        let ctx = Unmanaged.passUnretained(self).toOpaque()
        for note in Self.notifications {
            AXObserverAddNotification(obs, el, note as CFString, ctx)
        }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(obs), .defaultMode)

        self.adapter = adapter
        self.observer = obs
        self.appElement = el
        self.watchedPID = pid
        self.state = AXSensorState() // a different app is a different conversation context
        status = .watching(source: adapter.source, pid: pid)

        if dumpTree { dump(LiveAXNode(el), label: adapter.source) }
        scanSoon()
    }

    private func detach() {
        debounce?.cancel(); debounce = nil
        tailSettle?.cancel(); tailSettle = nil
        if let obs = observer, let el = appElement {
            for note in Self.notifications { AXObserverRemoveNotification(obs, el, note as CFString) }
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(obs), .defaultMode)
        }
        observer = nil
        appElement = nil
        watchedPID = nil
        adapter = nil
    }

    private static let notifications = [
        kAXValueChangedNotification,
        kAXCreatedNotification,
        kAXUIElementDestroyedNotification,
        kAXLayoutChangedNotification,
        kAXFocusedUIElementChangedNotification,
    ]

    // MARK: - scan

    fileprivate func scanSoon() {
        debounce?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.scan() }
        debounce = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
    }

    /// One follow-up scan past the settle interval, so a trailing turn that stopped streaming is
    /// still emitted after the last AX notification fired. Not a poll -- only while a tail is held.
    private func scheduleTailSettle() {
        tailSettle?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.scan() }
        tailSettle = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + AXConversationSensor.defaultSettleInterval + 0.3, execute: work
        )
    }

    private func scan() {
        guard let appElement, let adapter else { return }
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
        if step.holdingStreamingTail { scheduleTailSettle() }
        guard !step.settled.isEmpty else { return }

        let source = adapter.source
        let conversationID = "\(source)::ax::\(key)"
        let base = Date()
        let messages = step.settled.enumerated().map { i, m in
            (id: m.id, role: m.role, text: m.text,
             createdAt: iso.string(from: base.addingTimeInterval(Double(i))))
        }
        let fidelity = AXConversationSensor.batchFidelity(step.settled)
        Task { @MainActor [ingest] in await ingest(source, conversationID, messages, fidelity) }
    }

    // MARK: - diagnostics (THREAD_AX_DUMP=1)

    /// Print the AX subtree so the adapter hint sets can be tuned against real structure. This is
    /// the data a measurement pass produces; it is never on in a shipped build.
    private func dump(_ node: AXNode, label: String, depth: Int = 0, budget: Int = 1200) {
        guard depth == 0 || budget > 0 else { return }
        if depth == 0 { print("[ThreadMac AX] ===== tree dump: \(label) =====") }
        var remaining = budget
        var stack: [(AXNode, Int)] = [(node, 0)]
        while let (n, d) = stack.popLast(), remaining > 0 {
            remaining -= 1
            let text = n.axText.map { "\"\($0.prefix(50))\"" } ?? ""
            let id = n.axIdentifier.map { " id=\($0)" } ?? ""
            let desc = n.axDescription.map { " desc=\($0.prefix(30))" } ?? ""
            print("[ThreadMac AX] " + String(repeating: "  ", count: d) + "\(n.axRole)\(id)\(desc) \(text)")
            for c in n.axChildren.reversed() { stack.append((c, d + 1)) }
        }
        if depth == 0 { print("[ThreadMac AX] ===== end dump =====") }
    }
}

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
