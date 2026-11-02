import Foundation

/// Which part of someone's history a recovery brings in.
enum RecoveryScope: String, Codable, Equatable {
    /// The default: what they're working on now.
    case recent
    /// Everything before that -- only when they ask for it.
    case older
}

/// How recovery chooses what to bring in -- the same rule in the extension (historySync.ts).
///
/// Newest first, always: a first recovery should show what the person is thinking about now, and
/// on the Free plan the 25-idea cap used to fill with their oldest, stalest conversations. The
/// default amount is the last `days` days or the newest `minCount` conversations, whichever is
/// more -- a date cutoff alone gives nothing to someone who's been away a few months. The rest is
/// "older", brought in only on request. The first batch is small so the first ideas land within
/// a minute while the rest carries on.
enum RecoveryWindow {
    static let days = 90
    static let minCount = 100
    static let firstBatch = 5

    /// Newest first; conversations with no date go last, in a stable order.
    static func ordered<T>(_ items: [T], date: (T) -> Date?, key: (T) -> String) -> [T] {
        items.sorted { a, b in
            switch (date(a), date(b)) {
            case let (x?, y?): return x != y ? x > y : key(a) < key(b)
            case (.some, .none): return true
            case (.none, .some): return false
            case (.none, .none): return key(a) < key(b)
            }
        }
    }

    /// Split newest-first items into the default recovery and the older rest.
    static func split<T>(_ newestFirst: [T], date: (T) -> Date?, now: Date) -> (recent: [T], older: [T]) {
        let cutoff = now.addingTimeInterval(-Double(days) * 86_400)
        let inWindow = newestFirst.prefix { (date($0) ?? .distantPast) >= cutoff }.count
        let n = min(newestFirst.count, max(inWindow, minCount))
        return (Array(newestFirst.prefix(n)), Array(newestFirst.dropFirst(n)))
    }

    /// Batch boundaries: a small first batch, then `size` at a time.
    static func batches(count: Int, size: Int, first: Int = firstBatch) -> [Range<Int>] {
        var out: [Range<Int>] = []
        var start = 0
        while start < count {
            let end = min(count, start + (out.isEmpty ? min(first, size) : size))
            out.append(start ..< end)
            start = end
        }
        return out
    }
}
