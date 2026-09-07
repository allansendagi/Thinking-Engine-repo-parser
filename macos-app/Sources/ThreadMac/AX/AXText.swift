import Foundation
import CryptoKit

/// Text normalization + hashing shared by the sensor and its adapters. Message identity is derived
/// from CONTENT, never from an `AXUIElement`'s address: the same turn observed again -- after a
/// virtualized scroll view recycled its elements, after a full subtree rebuild -- normalizes to
/// the same string and hashes to the same id, so the backend (which dedupes on message id) treats
/// it as already-seen. Nothing here depends on element or index stability.
enum AXText {
    /// Trim, then collapse every internal run of whitespace (including newlines) to one space.
    static func normalize(_ s: String) -> String {
        let collapsed = s.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
        return collapsed.trimmingCharacters(in: .whitespaces)
    }

    /// First 16 hex chars of SHA-256 -- enough to not collide across one conversation, short
    /// enough to read in a log line.
    static func shortHash(_ s: String) -> String {
        let digest = SHA256.hash(data: Data(s.utf8))
        return digest.map { String(format: "%02x", $0) }.joined().prefix(16).lowercased()
    }

    /// The stable id for one message. `conversationKey` scopes it so an identical short turn
    /// ("thanks") in two different conversations doesn't collide. Two identical turns in the SAME
    /// conversation still collide -- rare, and accepted: disambiguating by index would reintroduce
    /// exactly the positional fragility this scheme exists to avoid.
    static func messageID(conversationKey: String, role: String, text: String) -> String {
        "ax::\(conversationKey)::\(shortHash("\(role)\u{1}\(normalize(text))"))"
    }
}
