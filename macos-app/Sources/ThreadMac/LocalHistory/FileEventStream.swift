import CoreServices
import Foundation

/// A thin FSEvents stream: macOS tells us which files changed under some folders, coalesced by
/// the kernel, with no polling and no cost while nothing changes. This is the native replacement
/// for "re-check every N seconds".
///
/// File-level events (`kFSEventStreamCreateFlagFileEvents`) so a caller gets the exact paths, and
/// `latency` lets the system batch a burst (an AI tool streaming a reply rewrites its log many
/// times a second) into one callback. Events are delivered on a utility-QoS queue.
final class FileEventStream {
    private var stream: FSEventStreamRef?
    private let queue = DispatchQueue(label: "thread.fsevents", qos: .utility)
    private let onChange: ([String]) -> Void

    init(onChange: @escaping ([String]) -> Void) {
        self.onChange = onChange
    }

    deinit { stop() }

    /// Start (or restart) watching `paths`. Folders that don't exist yet are skipped -- the
    /// caller re-calls `watch` when one appears (see LocalHistoryWatch's periodic root check).
    func watch(_ paths: [String], latency: TimeInterval = 1.5) {
        stop()
        let existing = paths.filter { FileManager.default.fileExists(atPath: $0) }
        guard !existing.isEmpty else { return }

        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil, release: nil, copyDescription: nil
        )
        let callback: FSEventStreamCallback = { _, info, count, rawPaths, _, _ in
            guard let info else { return }
            let me = Unmanaged<FileEventStream>.fromOpaque(info).takeUnretainedValue()
            // With kFSEventStreamCreateFlagUseCFTypes the paths arrive as a CFArray of CFString.
            let array = unsafeBitCast(rawPaths, to: NSArray.self)
            let changed = (0..<count).compactMap { array[$0] as? String }
            if !changed.isEmpty { me.onChange(changed) }
        }
        let flags = UInt32(
            kFSEventStreamCreateFlagFileEvents
                | kFSEventStreamCreateFlagUseCFTypes
                | kFSEventStreamCreateFlagNoDefer
                | kFSEventStreamCreateFlagIgnoreSelf
        )
        guard let s = FSEventStreamCreate(
            kCFAllocatorDefault, callback, &context, existing as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow), latency, flags
        ) else { return }
        FSEventStreamSetDispatchQueue(s, queue)
        FSEventStreamStart(s)
        stream = s
    }

    func stop() {
        guard let s = stream else { return }
        FSEventStreamStop(s)
        FSEventStreamInvalidate(s)
        FSEventStreamRelease(s)
        stream = nil
    }
}
