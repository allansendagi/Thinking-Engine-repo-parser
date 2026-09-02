import Foundation

/// Stores the Thread account credential (userId + token, as one atomic unit) on disk in the
/// app's Application Support directory, file mode 0600.
///
/// Why not the Keychain: this app ships **unsigned** via GitHub Releases. A Keychain item's
/// access control is bound to the app's code signature, which changes on every ad-hoc `swift
/// build` / every new unsigned download -- so the user gets a "ThreadMac wants to use your
/// confidential information" password prompt on essentially every launch. A 0600 file in the
/// user's own Application Support has no such prompt and is adequate protection for what this
/// token is (a bearer capability to the user's own idea data on the hosted backend). Once the
/// app has a stable Developer ID signature, moving the token back into the Keychain is the
/// right call -- see README.
enum CredentialStore {
    private static let apiBaseUrlKey = "thread.apiBaseUrl"
    private static let legacyUserIdKey = "thread.userId"
    static let defaultApiBaseUrl = "https://api.threadnow.app"

    struct Credential: Codable {
        let userId: String
        let token: String
    }

    private static var fileURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Thread", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("credential.json")
    }

    /// Coerces whatever the user typed into a usable absolute base URL. A bare host
    /// ("api.example.com") or a blank both become `URL(string:)` values that URLSession rejects
    /// with "unsupported URL" on every request -- so add the scheme, drop trailing slashes, and
    /// fall back to the default if the result still isn't a real https URL.
    static func normalizeBaseURL(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return defaultApiBaseUrl }
        if !s.lowercased().hasPrefix("http://") && !s.lowercased().hasPrefix("https://") {
            s = "https://" + s
        }
        while s.hasSuffix("/") { s.removeLast() }
        guard let u = URL(string: s), let scheme = u.scheme, scheme.hasPrefix("http"), u.host != nil else {
            return defaultApiBaseUrl
        }
        return s
    }

    static var apiBaseUrl: String {
        get {
            let stored = UserDefaults.standard.string(forKey: apiBaseUrlKey)?.trimmingCharacters(in: .whitespaces)
            // An empty string is not nil, so `??` won't catch a blank saved by an earlier build --
            // and a blank becomes URL(string:) -> "unsupported URL" on every request.
            guard let stored, stored.hasPrefix("http") else { return defaultApiBaseUrl }
            return stored
        }
        set {
            let v = normalizeBaseURL(newValue)
            if v == defaultApiBaseUrl { UserDefaults.standard.removeObject(forKey: apiBaseUrlKey) }
            else { UserDefaults.standard.set(v, forKey: apiBaseUrlKey) }
        }
    }

    static var credential: Credential? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? JSONDecoder().decode(Credential.self, from: data)
    }

    /// Back-compat shape for call sites that expect a tuple.
    static var credentials: (userId: String, token: String)? {
        credential.map { ($0.userId, $0.token) }
    }

    static var userId: String? { credential?.userId }

    static func save(userId: String, token: String) {
        guard let data = try? JSONEncoder().encode(Credential(userId: userId, token: token)) else { return }
        try? data.write(to: fileURL, options: [.atomic, .completeFileProtection])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        UserDefaults.standard.removeObject(forKey: legacyUserIdKey)
    }

    static func clear() {
        try? FileManager.default.removeItem(at: fileURL)
        UserDefaults.standard.removeObject(forKey: legacyUserIdKey)
    }
}
