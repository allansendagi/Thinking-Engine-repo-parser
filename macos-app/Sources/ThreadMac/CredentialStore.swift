import Foundation
import Security

/// Stores the Thread account credential in the macOS Keychain. userId and token are kept
/// together as one atomic JSON item, deliberately: an earlier version split them (token in
/// Keychain, userId in UserDefaults), which let a stale userId from one build pair with a fresh
/// token from another -- a guaranteed 401. One item, written and cleared as a unit, makes that
/// half-state impossible. apiBaseUrl isn't secret and stays in UserDefaults.
enum CredentialStore {
    private static let service = "com.thread.mac.credential"
    private static let account = "default"
    private static let apiBaseUrlKey = "thread.apiBaseUrl"
    private static let legacyUserIdKey = "thread.userId"
    static let defaultApiBaseUrl = "https://thinking-engine-repo-parser-production.up.railway.app"

    struct Credential: Codable {
        let userId: String
        let token: String
    }

    static var apiBaseUrl: String {
        get { UserDefaults.standard.string(forKey: apiBaseUrlKey) ?? defaultApiBaseUrl }
        set { UserDefaults.standard.set(newValue, forKey: apiBaseUrlKey) }
    }

    static var credential: Credential? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let cred = try? JSONDecoder().decode(Credential.self, from: data)
        else { return nil }
        return cred
    }

    /// Back-compat shape for call sites that expect a tuple.
    static var credentials: (userId: String, token: String)? {
        credential.map { ($0.userId, $0.token) }
    }

    static var userId: String? { credential?.userId }

    static func save(userId: String, token: String) {
        guard let data = try? JSONEncoder().encode(Credential(userId: userId, token: token)) else { return }
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        var attributes = base
        attributes[kSecValueData as String] = data
        SecItemAdd(attributes as CFDictionary, nil)
        UserDefaults.standard.removeObject(forKey: legacyUserIdKey)
    }

    static func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        UserDefaults.standard.removeObject(forKey: legacyUserIdKey)
    }
}
