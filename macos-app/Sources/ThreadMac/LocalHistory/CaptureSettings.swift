import Foundation

/// The person's choices about what Thread captures on this Mac. Local AI histories are on by
/// default per tool (they're the person's own files and are only read, never changed).
enum CaptureSettings {
    private static let disabledLocalKey = "thread.capture.localDisabled"

    static func isLocalSourceEnabled(_ source: String) -> Bool {
        !(UserDefaults.standard.stringArray(forKey: disabledLocalKey) ?? []).contains(source)
    }

    static func setLocalSource(_ source: String, enabled: Bool) {
        var off = Set(UserDefaults.standard.stringArray(forKey: disabledLocalKey) ?? [])
        if enabled { off.remove(source) } else { off.insert(source) }
        UserDefaults.standard.set(Array(off).sorted(), forKey: disabledLocalKey)
    }
}
