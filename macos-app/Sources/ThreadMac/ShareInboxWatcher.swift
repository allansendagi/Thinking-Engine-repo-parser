import AppKit
import Foundation

/// Captures what the Share extension drops into the shared inbox. Runs while the app runs: on launch
/// (anything shared while it was closed), whenever the inbox folder changes, when the app is brought
/// forward, and once a minute as a safety net (shares made before sign-in are retried).
@MainActor
final class ShareInboxWatcher {
    private let capture: (String) -> Bool
    private var source: DispatchSourceFileSystemObject?
    private var timer: Timer?
    private var activation: NSObjectProtocol?

    init(capture: @escaping (String) -> Bool) { self.capture = capture }

    func start() {
        if let dir = ShareInbox.directory {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            watch(dir)
        }
        drain()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.drain() }
        }
        activation = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.drain() }
        }
    }

    func drain() { ShareInbox.drain(capture: capture) }

    private func watch(_ dir: URL) {
        let fd = open(dir.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let src = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: .write, queue: .main)
        src.setEventHandler { [weak self] in
            // A moment for the extension to finish writing, then take what's there.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { MainActor.assumeIsolated { self?.drain() } }
        }
        src.setCancelHandler { close(fd) }
        src.resume()
        source = src
    }
}
