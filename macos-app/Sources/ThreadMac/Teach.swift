import Foundation

/// Teach Thread (GET /v1/learn): a few questions, chosen on the server so each answer teaches the
/// most -- "Keep this?" on ideas Thread is least sure about, "Same idea?" on two related ideas right
/// on the line. Answers feed the same learning as a Keep / Not an idea click, without skewing the
/// acceptance rate. Offered at most once a day, never alongside another nudge.

struct LessonIdea: Codable, Equatable {
    let ideaId: String
    let title: String
    let statement: String
    let source: String?
    let lastTouched: String
}

enum LessonQuestion: Codable, Equatable, Identifiable {
    case idea(LessonIdea, unsure: Bool)
    case pair(LessonIdea, LessonIdea)

    var id: String {
        switch self {
        case .idea(let i, _): return "idea:" + i.ideaId
        case .pair(let a, let b): return "pair:" + a.ideaId + "+" + b.ideaId
        }
    }

    private enum Keys: String, CodingKey { case kind, reason, a, b }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "pair":
            self = .pair(try c.decode(LessonIdea.self, forKey: .a), try c.decode(LessonIdea.self, forKey: .b))
        default:
            let reason = try c.decodeIfPresent(String.self, forKey: .reason)
            self = .idea(try LessonIdea(from: decoder), unsure: reason == "unsure")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .idea(let i, let unsure):
            try c.encode("idea", forKey: .kind)
            try c.encode(unsure ? "unsure" : "new", forKey: .reason)
            try i.encode(to: encoder)
        case .pair(let a, let b):
            try c.encode("pair", forKey: .kind)
            try c.encode(a, forKey: .a)
            try c.encode(b, forKey: .b)
        }
    }
}

struct Lesson: Codable, Equatable {
    let questions: [LessonQuestion]
    /// Everything Thread has learned from so far.
    let learned: Int
    /// Share of recent verdicts on ideas Thread showed (browsing, not lessons) that were Keep.
    let acceptanceRate: Double?
    /// How many verdicts that rate is over. Optional: older backends don't send it.
    var acceptanceSample: Int?
    let ready: Bool
}

/// The rate is shown only once it rests on enough verdicts to mean something.
let minimumAcceptanceSample = 10

/// "You kept 82% of the ideas Thread showed you recently." -- or nothing, while there are too few.
func keptRateSentence(rate: Double?, sample: Int?) -> String? {
    guard let rate, let sample, sample >= minimumAcceptanceSample else { return nil }
    return "You kept \(Int((rate * 100).rounded()))% of the ideas Thread showed you recently."
}

enum LessonAnswer: String {
    case keep, notIdea = "not_idea", skip, same, different
}

/// Worth inviting today? Enough questions to be worth the minute, not already offered or declined
/// today, and nothing else is asking for attention. Pure, so the rule is testable.
func shouldInviteLesson(_ lesson: Lesson?, lastOffered: Date?, otherNudgeShowing: Bool, now: Date = Date(), calendar: Calendar = .current) -> Bool {
    guard let lesson, lesson.questions.count >= 3, !otherNudgeShowing else { return false }
    if let lastOffered, calendar.isDate(lastOffered, inSameDayAs: now) { return false }
    return true
}

extension AppState {
    static let lessonOfferedKey = "thread.lesson.lastOffered"

    var lessonLastOffered: Date? { UserDefaults.standard.object(forKey: Self.lessonOfferedKey) as? Date }

    static let panelOpenedKey = "thread.panel.lastOpened"
    /// When the person last opened Thread's panel -- the invitation would have been in front of them.
    var lastPanelOpenedAt: Date? { UserDefaults.standard.object(forKey: Self.panelOpenedKey) as? Date }
    func notePanelOpened() { UserDefaults.standard.set(Date(), forKey: Self.panelOpenedKey) }

    var showsLessonInvite: Bool {
        shouldInviteLesson(lesson, lastOffered: lessonLastOffered, otherNudgeShowing: resumeSuggestion != nil)
    }

    /// Best-effort: an older backend or being offline simply means no invitation. Picking a lesson
    /// scores every idea, so it's fetched when Thread is opened and every few hours -- not on every
    /// background sync.
    func refreshLesson(force: Bool = false) async {
        guard isPaired, !lessonOpen else { return }
        if !force, let last = lessonFetchedAt, Date().timeIntervalSince(last) < 3 * 3600 { return }
        if let l = try? await client.getLesson() {
            lesson = l
            lessonFetchedAt = Date()
        }
    }

    /// "Not now" (or starting it) uses today's invitation.
    func markLessonOffered() {
        UserDefaults.standard.set(Date(), forKey: Self.lessonOfferedKey)
        objectWillChange.send()
    }

    func startLesson() async {
        markLessonOffered()
        if lesson == nil || lesson?.questions.isEmpty == true { await refreshLesson(force: true) }
        lessonQuestions = lesson?.questions ?? []
        lessonIndex = 0
        lessonAnswered = 0
        lessonError = nil
        lessonOpen = true
    }

    func closeLesson() {
        lessonOpen = false
        Task { await refreshLesson(force: true); await refresh() }
    }

    /// Record one answer and move on. Optimistic: the next question shows at once; a failed save is
    /// said plainly and the same question stays, so nothing is lost silently.
    func answerLesson(_ answer: LessonAnswer) async {
        guard lessonIndex < lessonQuestions.count else { return }
        let q = lessonQuestions[lessonIndex]
        var body: [String: String] = ["answer": answer.rawValue]
        switch q {
        case .idea(let i, _): body["kind"] = "idea"; body["ideaId"] = i.ideaId
        case .pair(let a, let b): body["kind"] = "pair"; body["a"] = a.ideaId; body["b"] = b.ideaId
        }
        lessonError = nil
        let from = lessonIndex
        lessonIndex += 1
        if answer != .skip { lessonAnswered += 1 }
        do {
            let updated = try await client.answerLesson(body)
            lesson = updated
        } catch {
            lessonIndex = from
            if answer != .skip { lessonAnswered -= 1 }
            lessonError = "Couldn't save that answer — check your connection and try again."
        }
    }
}
