import AppKit
import Network

/// Brings the app back online on its own. `bootstrap()` / `refresh()` mark the app offline when
/// the backend is unreachable -- routinely the case when Thread launches at login before Wi-Fi is
/// up, or after the Mac sleeps. Without this nothing retried until the user clicked refresh, and
/// captures/edits queued offline sat unsent. Triggers a `refresh()` (which also flushes the
/// pending queues) when:
///   • the network path becomes usable again while we're offline,
///   • the Mac wakes from sleep,
///   • the recall panel opens and the last good sync is stale (see `AppState.refreshIfStale`).
@MainActor
final class ConnectivityWatcher {
    private let appState: AppState
    private let monitor = NWPathMonitor()
    private var wakeObserver: NSObjectProtocol?
    private var wasSatisfied = true

    init(appState: AppState) {
        self.appState = appState
    }

    func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            Task { @MainActor in self?.pathChanged(satisfied: satisfied) }
        }
        monitor.start(queue: DispatchQueue(label: "com.thread.mac.connectivity"))

        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            // Give Wi-Fi a moment to re-associate; the path monitor covers it if it takes longer.
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(3))
                await self?.appState.refreshIfStale(olderThan: 0)
            }
        }
    }

    func stop() {
        monitor.cancel()
        if let wakeObserver { NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver) }
    }

    private func pathChanged(satisfied: Bool) {
        defer { wasSatisfied = satisfied }
        guard satisfied, !wasSatisfied || appState.isOffline else { return }
        Task { await appState.refreshIfStale(olderThan: 0) }
    }
}

extension AppState {
    /// Re-sync unless a sync is already running or the last good one is recent. Offline always
    /// counts as stale. Cheap to call: no-ops when unpaired / mid-reconnect (see `refresh()`).
    func refreshIfStale(olderThan seconds: TimeInterval = 120) async {
        guard !isLoading else { return }
        if !isOffline, let last = lastSyncedAt, Date().timeIntervalSince(last) < seconds { return }
        await refresh()
    }
}
