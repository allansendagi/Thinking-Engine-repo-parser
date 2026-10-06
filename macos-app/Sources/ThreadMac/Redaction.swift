import Foundation

/// On-device first pass: credentials are stripped from captured text before it leaves the Mac.
/// Mirrors `src/capture/redact.ts` (same patterns, same `[redacted <kind>]` output, idempotent);
/// the shared vectors live in `src/capture/redact.test.ts` and `RedactionTests`.
enum Redaction {
    /// (kind, pattern, template). Prefix-keeping patterns capture the prefix as $1 -- ICU has no
    /// unbounded lookbehind, so the TypeScript lookbehinds become a captured prefix here.
    private static let rules: [(String, NSRegularExpression, String)] = {
        let specs: [(String, String, NSRegularExpression.Options, Bool)] = [
            ("private key", #"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"#, [], false),
            ("api key", #"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}"#, [], false),
            ("stripe key", #"\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}"#, [], false),
            ("aws key", #"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"#, [], false),
            ("github token", #"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})"#, [], false),
            ("slack token", #"\bxox[abprs]-[A-Za-z0-9-]{10,}"#, [], false),
            ("google key", #"\bAIza[0-9A-Za-z_-]{35}\b"#, [], false),
            ("jwt", #"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"#, [], false),
            ("bearer token", #"(\bBearer\s+)[A-Za-z0-9._~+/-]{24,}=*"#, [], true),
            ("secret", #"(\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["']?)(?!\[redacted)[^\s"'`,;]{8,}"#, [.caseInsensitive], true),
        ]
        return specs.map { kind, pattern, options, keepsPrefix in
            // Patterns are literals checked by RedactionTests; a bad one is a build-time bug.
            let re = try! NSRegularExpression(pattern: pattern, options: options)
            return (kind, re, (keepsPrefix ? "$1" : "") + "[redacted \(kind)]")
        }
    }()

    static func redact(_ text: String) -> String {
        guard text.count >= 8 else { return text }
        var out = text
        for (_, re, template) in rules {
            let range = NSRange(out.startIndex..., in: out)
            out = re.stringByReplacingMatches(in: out, range: range, withTemplate: template)
        }
        return out
    }

    /// Every string inside JSON-shaped values (export conversations).
    static func redactDeep(_ value: Any) -> Any {
        switch value {
        case let s as String: return redact(s)
        case let a as [Any]: return a.map(redactDeep)
        case let d as [String: Any]: return d.mapValues(redactDeep)
        default: return value
        }
    }
}
