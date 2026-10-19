import Foundation

/// This Mac's install of Thread, for counting installs honestly: a random UUID made on first
/// launch and kept in the app's preferences. It survives signing out and back in (which creates a
/// new anonymous account), so one Mac counts as one install. Not derived from the hardware or
/// from anything about the person; sent with the macOS version, nothing else.
enum InstallIdentity {
    static let defaultsKey = "thread.installId"

    static func id(in defaults: UserDefaults = .standard) -> String {
        if let existing = defaults.string(forKey: defaultsKey), UUID(uuidString: existing) != nil {
            return existing
        }
        let made = UUID().uuidString.lowercased()
        defaults.set(made, forKey: defaultsKey)
        return made
    }

    /// "26.0.1"
    static var osVersion: String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }
}
