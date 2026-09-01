import Foundation
import Security

/// Stores the pairing token in the macOS Keychain, not a plaintext file -- the same credential
/// the browser extension keeps in chrome.storage.local, but chrome.storage.local has no
/// equivalent OS-level encryption-at-rest guarantee the way Keychain items do. userId and
/// apiBaseUrl aren't secret, so they live in UserDefaults; only the token goes in Keychain.
enum CredentialStore {
    private static let service = "com.thread.mac.token"
    private static let userIdKey = "thread.userId"
    private static let apiBaseUrlKey = "thread.apiBaseUrl"
    static let defaultApiBaseUrl = "http://localhost:8787"

    static var apiBaseUrl: String {
        get { UserDefaults.standard.string(forKey: apiBaseUrlKey) ?? defaultApiBaseUrl }
        set { UserDefaults.standard.set(newValue, forKey: apiBaseUrlKey) }
    }

    static var userId: String? {
        get { UserDefaults.standard.string(forKey: userIdKey) }
        set { UserDefaults.standard.set(newValue, forKey: userIdKey) }
    }

    static func saveToken(_ token: String) {
        let data = Data(token.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        SecItemDelete(query as CFDictionary) // idempotent: clear any prior value first
        var attributes = query
        attributes[kSecValueData as String] = data
        SecItemAdd(attributes as CFDictionary, nil)
    }

    static func loadToken() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func clear() {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        SecItemDelete(query as CFDictionary)
        userId = nil
    }

    static var credentials: (userId: String, token: String)? {
        guard let userId, let token = loadToken() else { return nil }
        return (userId, token)
    }

    static func save(userId: String, token: String) {
        self.userId = userId
        saveToken(token)
    }
}
