import Foundation

/// Stores the Thread account credential (userId + token + the account's email once known, as one
/// atomic unit) on disk in the app's Application Support directory, file mode 0600, with a `.bak`
/// sibling written on every save.
///
/// Why not the Keychain: this app ships **unsigned** via GitHub Releases. A Keychain item's
/// access control is bound to the app's code signature, which changes on every ad-hoc `swift
/// build` / every new unsigned download -- so the user gets a "ThreadMac wants to use your
/// confidential information" password prompt on essentially every launch. A 0600 file in the
/// user's own Application Support has no such prompt and is adequate protection for what this
/// token is (a bearer capability to the user's own idea data on the hosted backend). Once the
/// app has a stable Developer ID signature, moving the token back into the Keychain is the
/// right call -- see README.
///
/// Resilience: the file is written **without** a data-protection class. `NSFileProtectionComplete`
/// makes the file unreadable until the Mac is first unlocked after boot -- a login-item launch
/// then reads nil and the app used to mint a brand-new empty account over a perfectly good one.
/// A read failure now means "unreadable", never "no account" (see `LoadResult`), and a `.bak`
/// copy covers a torn write.
enum CredentialStore {
    private static let apiBaseUrlKey = "thread.apiBaseUrl"
    private static let legacyUserIdKey = "thread.userId"
    private static let lastKnownEmailKey = "thread.lastKnownEmail"
    private static let deliberateSignOutKey = "thread.deliberateSignOut"
    static let defaultApiBaseUrl = "https://thinking-engine-repo-parser-production.up.railway.app"

    struct Credential: Codable {
        let userId: String
        let token: String
        /// The verified email on this account, once we've seen it. Lets recovery offer a
        /// one-tap "send a code to you@…" instead of asking who this Mac belongs to.
        var email: String?
    }

    /// The outcome of trying to load the credential. The distinction that matters: `absent`
    /// (no file -- a genuine first run) versus `unreadable` (a file is there but we can't read
    /// or decode it right now -- never a reason to start a new account).
    enum LoadResult {
        case ok(Credential)
        case unreadable
        case absent
    }

    /// Test seam: when set, the store reads and writes here instead of `~/Library/Application
    /// Support/Thread`. Always nil in the shipping app.
    static var directoryOverride: URL?

    private static var dirURL: URL {
        let base = directoryOverride
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Thread", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }

    private static var fileURL: URL { dirURL.appendingPathComponent("credential.json") }
    private static var backupURL: URL { dirURL.appendingPathComponent("credential.json.bak") }

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

    /// Full load result -- callers deciding whether to recover vs. onboard use this.
    static func load() -> LoadResult {
        let primaryExists = FileManager.default.fileExists(atPath: fileURL.path)

        if let cred = decode(fileURL) {
            return .ok(cred)
        }
        // Primary missing or unreadable -- try the backup, and if it works, heal the primary.
        if let cred = decode(backupURL) {
            writeAtomically(cred, to: fileURL) // best effort; the backup already carried us
            return .ok(cred)
        }
        let backupExists = FileManager.default.fileExists(atPath: backupURL.path)
        return (primaryExists || backupExists) ? .unreadable : .absent
    }

    static var credential: Credential? {
        if case .ok(let c) = load() { return c }
        return nil
    }

    /// Back-compat shape for call sites that expect a tuple.
    static var credentials: (userId: String, token: String)? {
        credential.map { ($0.userId, $0.token) }
    }

    static var userId: String? { credential?.userId }

    /// The last account email this Mac saw, mirrored to UserDefaults so it survives even a total
    /// loss of the credential file. Recovery uses it to pre-fill the sign-in code screen.
    static var lastKnownEmail: String? {
        UserDefaults.standard.string(forKey: lastKnownEmailKey)?.trimmingCharacters(in: .whitespaces).nilIfEmpty
    }

    static func rememberEmail(_ email: String?) {
        guard let email = email?.trimmingCharacters(in: .whitespaces).nilIfEmpty else { return }
        UserDefaults.standard.set(email, forKey: lastKnownEmailKey)
    }

    static func save(userId: String, token: String, email: String? = nil) {
        let resolvedEmail = email?.trimmingCharacters(in: .whitespaces).nilIfEmpty ?? credential?.email
        let cred = Credential(userId: userId, token: token, email: resolvedEmail)
        writeAtomically(cred, to: fileURL)
        writeAtomically(cred, to: backupURL)
        rememberEmail(resolvedEmail)
        UserDefaults.standard.removeObject(forKey: legacyUserIdKey)
        UserDefaults.standard.removeObject(forKey: deliberateSignOutKey)
    }

    /// Wipe the credential. Only `unpair()` calls this, so it also records that the user chose to
    /// sign out -- `bootstrap()` reads that to show onboarding, not the reconnect screen, on the
    /// next launch even if a stale snapshot from an old account is still on disk.
    static func clear() {
        try? FileManager.default.removeItem(at: fileURL)
        try? FileManager.default.removeItem(at: backupURL)
        UserDefaults.standard.removeObject(forKey: legacyUserIdKey)
        UserDefaults.standard.removeObject(forKey: lastKnownEmailKey)
        UserDefaults.standard.set(true, forKey: deliberateSignOutKey)
    }

    /// True between an explicit sign-out and the next successful pair / sign-in.
    static var deliberatelySignedOut: Bool {
        UserDefaults.standard.bool(forKey: deliberateSignOutKey)
    }

    /// Once the app is showing the reconnect screen, "deliberately signed out" no longer
    /// describes the state -- clear it so a later credential loss still routes to reconnect.
    static func clearDeliberateSignOut() {
        UserDefaults.standard.removeObject(forKey: deliberateSignOutKey)
    }

    // MARK: - private

    private static func decode(_ url: URL) -> Credential? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Credential.self, from: data)
    }

    /// Write 0600, atomically, with data protection explicitly **off** -- see the type doc. On
    /// current macOS a plain `.atomic` write still lands as
    /// `NSFileProtectionCompleteUntilFirstUserAuthentication` (verified on Apple Silicon), which
    /// is unreadable at the loginwindow before the user's first unlock; `.none` makes the file
    /// readable at every launch, which is the whole job of this credential. A missing directory
    /// is created first.
    private static func writeAtomically(_ cred: Credential, to url: URL) {
        guard let data = try? JSONEncoder().encode(cred) else { return }
        try? FileManager.default.createDirectory(at: dirURL, withIntermediateDirectories: true)
        try? data.write(to: url, options: [.atomic])
        try? FileManager.default.setAttributes(
            [.posixPermissions: 0o600, .protectionKey: FileProtectionType.none],
            ofItemAtPath: url.path
        )
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
