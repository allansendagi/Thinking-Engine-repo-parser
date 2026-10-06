import Foundation
import Security

/// Keychain storage for the account credential -- used only when this build is signed with a
/// Developer ID (has a Team ID). A Keychain item's access is tied to the app's code signature;
/// with a stable Developer ID that survives every update, but an ad-hoc/unsigned build gets a new
/// identity per build and would hit a password prompt on every launch -- so those keep using the
/// 0600 file (see CredentialStore).
enum KeychainCredential {
    private static let service = "com.thread.mac"
    private static let account = "credential"

    enum ReadResult {
        case found(Data)
        case notFound
        /// Present but not readable right now (locked keychain, access denied). Never "no account".
        case failed(OSStatus)
    }

    /// True when the running app carries a Developer ID / App Store Team ID.
    static let isAvailable: Bool = {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return false }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return false }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let dict = info as? [String: Any] else { return false }
        let team = dict[kSecCodeInfoTeamIdentifier as String] as? String
        return !(team ?? "").isEmpty
    }()

    private static var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func read() -> ReadResult {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        switch status {
        case errSecSuccess:
            guard let data = out as? Data else { return .failed(status) }
            return .found(data)
        case errSecItemNotFound:
            return .notFound
        default:
            return .failed(status)
        }
    }

    @discardableResult
    static func write(_ data: Data) -> Bool {
        let update = SecItemUpdate(baseQuery as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return true }
        guard update == errSecItemNotFound else { return false }
        var add = baseQuery
        add[kSecValueData as String] = data
        // Readable after the first unlock since boot -- a login-item launch must never read "nothing".
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        add[kSecAttrLabel as String] = "Thread account"
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func delete() {
        SecItemDelete(baseQuery as CFDictionary)
    }
}
