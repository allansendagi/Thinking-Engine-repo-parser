import Foundation

/// The person's choices about what Thread captures on this Mac. Local AI histories are on by
/// default per tool (they're the person's own files and are only read, never changed); reading
/// desktop apps' windows through Accessibility is an explicit opt-in (beta).
enum CaptureSettings {
    private static let desktopAppsKey = "thread.capture.desktopApps"
    private static let disabledLocalKey = "thread.capture.localDisabled"

    static var desktopApps: Bool {
        get { UserDefaults.standard.bool(forKey: desktopAppsKey) }
        set { UserDefaults.standard.set(newValue, forKey: desktopAppsKey) }
    }

    static func isLocalSourceEnabled(_ source: String) -> Bool {
        !(UserDefaults.standard.stringArray(forKey: disabledLocalKey) ?? []).contains(source)
    }

    static func setLocalSource(_ source: String, enabled: Bool) {
        var off = Set(UserDefaults.standard.stringArray(forKey: disabledLocalKey) ?? [])
        if enabled { off.remove(source) } else { off.insert(source) }
        UserDefaults.standard.set(Array(off).sorted(), forKey: disabledLocalKey)
    }
}
