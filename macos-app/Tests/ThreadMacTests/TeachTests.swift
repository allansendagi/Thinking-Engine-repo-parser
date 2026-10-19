import XCTest
import SwiftUI
@testable import ThreadMac

final class TeachTests: XCTestCase {
    static let json = """
    {"learned":51,"acceptanceRate":0.8,"ready":true,"questions":[
      {"kind":"idea","reason":"unsure","ideaId":"i1","title":"Price increase for workshop","statement":"Pricing communicates positioning.","source":"chatgpt","lastTouched":"2026-10-12T00:00:00Z"},
      {"kind":"idea","reason":"new","ideaId":"i2","title":"Bounded Contextual Authority Economics","statement":"Offer 48-hour audits to enterprises deploying autonomous agents.","source":"chatgpt","lastTouched":"2026-10-10T00:00:00Z"},
      {"kind":"pair","a":{"ideaId":"i3","title":"Compile authority","statement":"Separate policy compilation from policy execution so ambiguity is resolved at the authority boundary.","source":"chatgpt","lastTouched":"2026-10-09T00:00:00Z"},
                     "b":{"ideaId":"i4","title":"The Nanny Pattern","statement":"All agents can only talk to the Nanny to get tools executed on their behalf.","source":"claude","lastTouched":"2026-10-06T00:00:00Z"}}
    ]}
    """

    func testDecodesIdeaAndPairQuestions() throws {
        let l = try JSONDecoder().decode(Lesson.self, from: Data(Self.json.utf8))
        XCTAssertEqual(l.questions.count, 3)
        guard case .idea(let i, let unsure) = l.questions[0] else { return XCTFail("idea first") }
        XCTAssertEqual([i.ideaId, unsure ? "unsure" : "new"], ["i1", "unsure"])
        guard case .pair(let a, let b) = l.questions[2] else { return XCTFail("pair last") }
        XCTAssertEqual([a.ideaId, b.ideaId], ["i3", "i4"])
    }

    func testInvitesAtMostOnceADayAndNeverOverAnotherNudge() throws {
        let l = try JSONDecoder().decode(Lesson.self, from: Data(Self.json.utf8))
        let now = Date()
        XCTAssertTrue(shouldInviteLesson(l, lastOffered: nil, otherNudgeShowing: false, now: now))
        XCTAssertFalse(shouldInviteLesson(l, lastOffered: now.addingTimeInterval(-3600), otherNudgeShowing: false, now: now))
        XCTAssertTrue(shouldInviteLesson(l, lastOffered: now.addingTimeInterval(-26 * 3600), otherNudgeShowing: false, now: now))
        XCTAssertFalse(shouldInviteLesson(l, lastOffered: nil, otherNudgeShowing: true, now: now))
        let tiny = Lesson(questions: Array(l.questions.prefix(2)), learned: 0, acceptanceRate: nil, ready: false)
        XCTAssertFalse(shouldInviteLesson(tiny, lastOffered: nil, otherNudgeShowing: false, now: now))
    }

    func testTheKeptRateNeedsEnoughAnswersAndIsWorded() {
        XCTAssertNil(keptRateSentence(rate: 0, sample: 1)) // one click is not a rate
        XCTAssertNil(keptRateSentence(rate: 0.8, sample: nil))
        XCTAssertEqual(keptRateSentence(rate: 0.82, sample: 12), "You kept 82% of the ideas Thread showed you recently.")
    }

    func testLessonNotificationIsRareAndNeverRedundant() {
        let now = Date()
        let day: TimeInterval = 86_400
        XCTAssertTrue(lessonNotificationShouldFire(now: now, lessonReady: true, lastNotified: nil, lastOpenedThread: now.addingTimeInterval(-2 * day), lastOffered: nil))
        XCTAssertFalse(lessonNotificationShouldFire(now: now, lessonReady: false, lastNotified: nil, lastOpenedThread: nil, lastOffered: nil))
        XCTAssertFalse(lessonNotificationShouldFire(now: now, lessonReady: true, lastNotified: now.addingTimeInterval(-6 * day), lastOpenedThread: nil, lastOffered: nil)) // weekly
        XCTAssertFalse(lessonNotificationShouldFire(now: now, lessonReady: true, lastNotified: nil, lastOpenedThread: now, lastOffered: nil)) // saw the card today
        XCTAssertFalse(lessonNotificationShouldFire(now: now, lessonReady: true, lastNotified: nil, lastOpenedThread: nil, lastOffered: now)) // already offered today
        XCTAssertTrue(lessonNotificationShouldFire(now: now, lessonReady: true, lastNotified: now.addingTimeInterval(-8 * day), lastOpenedThread: nil, lastOffered: nil))
    }

    /// Renders the lesson screens to PNGs for a visual check (written only when THREAD_RENDER_DIR is set).
    @MainActor
    func testRenderLessonScreens() throws {
        guard let dir = ProcessInfo.processInfo.environment["THREAD_RENDER_DIR"] else { throw XCTSkip("set THREAD_RENDER_DIR to render") }
        let l = try JSONDecoder().decode(Lesson.self, from: Data(Self.json.utf8))
        UserDefaults.standard.set(false, forKey: "thread.lesson.introSeen")
        for (name, index) in [("lesson-intro", 0), ("lesson-idea", 0), ("lesson-pair", 2), ("lesson-done", 3)] {
            UserDefaults.standard.set(name != "lesson-intro", forKey: "thread.lesson.introSeen")
            let state = AppState()
            state.lesson = l
            state.lessonQuestions = l.questions
            state.lessonIndex = index
            state.lessonAnswered = 3
            state.lessonOpen = true
            let view = TeachThreadView().environmentObject(state)
                .frame(width: Theme.panelWidth, height: 560)
                .background(Theme.panelTint)
            let r = ImageRenderer(content: view)
            r.scale = 2
            guard let img = r.nsImage, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else { return XCTFail("render failed") }
            try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
        UserDefaults.standard.removeObject(forKey: "thread.lesson.introSeen")
        let invite = AppState()
        invite.lesson = l
        let bar = LessonInvite().environmentObject(invite).frame(width: Theme.panelWidth).padding(.vertical, 10).background(Theme.panelTint)
        let r = ImageRenderer(content: bar)
        r.scale = 2
        if let img = r.nsImage, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
            try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("lesson-invite.png"))
        }
    }
}
