import XCTest
@testable import ThreadMac

/// A speech engine that says exactly what the test tells it to, so every state of a voice capture
/// can be exercised without a microphone, a permission prompt or a real recogniser.
@MainActor
private final class FakeEngine: SpeechEngine {
    var onPartial: ((String) -> Void)?
    var onLevel: ((Float) -> Void)?
    var onFinal: ((String) -> Void)?
    var onError: ((String) -> Void)?
    var authorization: VoiceAuthorization = .ready
    var startError: Error?
    private(set) var started = 0, stopped = 0, cancelled = 0
    /// What the recogniser will report once told to stop.
    var finalText = ""
    func authorize() async -> VoiceAuthorization { authorization }
    func start() throws { if let startError { throw startError }; started += 1 }
    func stop() { stopped += 1; onFinal?(finalText) }
    func cancel() { cancelled += 1 }
}

@MainActor
final class VoiceCaptureTests: XCTestCase {
    private func session(_ engine: FakeEngine, captured: @escaping (String) -> Void = { _ in }, accept: Bool = true) -> VoiceSession {
        VoiceSession(engine: engine) { text in captured(text); return accept }
    }

    /// Lets the async `begin()` that `press()` starts run to completion.
    private func settle() async { try? await Task.sleep(nanoseconds: 50_000_000) }

    func testTranscriptRules() {
        XCTAssertEqual(VoiceTranscript.clean("  Charge for\n outcomes,   not seats.  "), "Charge for outcomes, not seats.")
        XCTAssertEqual(VoiceTranscript.wordCount("one two  three"), 3)
        XCTAssertFalse(VoiceTranscript.releaseEndsCapture(heldFor: 0.12), "a quick tap toggles instead")
        XCTAssertTrue(VoiceTranscript.releaseEndsCapture(heldFor: 0.9), "a deliberate hold ends on release")
    }

    func testPressListensThenSecondPressCaptures() async {
        let engine = FakeEngine()
        engine.finalText = "Authority should be checkable before the action happens"
        var got: [String] = []
        let s = session(engine) { got.append($0) }
        s.press()
        await settle()
        XCTAssertEqual(s.phase, .listening)
        XCTAssertEqual(engine.started, 1)
        engine.onPartial?("Authority should be")
        XCTAssertEqual(s.transcript, "Authority should be")
        s.press()                                  // the second press ends it
        XCTAssertEqual(got, ["Authority should be checkable before the action happens"])
        XCTAssertEqual(s.phase, .captured)
    }

    func testHoldToTalkEndsOnRelease() async {
        let engine = FakeEngine()
        engine.finalText = "Delegation should only ever narrow"
        var got: [String] = []
        let s = session(engine) { got.append($0) }
        s.press()
        await settle()
        s.release(heldFor: 0.9)
        XCTAssertEqual(got, ["Delegation should only ever narrow"])
    }

    func testQuickTapKeepsListening() async {
        let engine = FakeEngine()
        let s = session(engine)
        s.press()
        await settle()
        s.release(heldFor: 0.1)                    // tap: stays on until pressed again
        XCTAssertEqual(s.phase, .listening)
        XCTAssertEqual(engine.stopped, 0)
    }

    func testTooShortIsNotCaptured() async {
        let engine = FakeEngine()
        engine.finalText = "um okay"
        var got: [String] = []
        let s = session(engine) { got.append($0) }
        s.press()
        await settle()
        s.press()
        XCTAssertEqual(got, [])
        XCTAssertEqual(s.phase, .failed("That was too short to capture."))
    }

    func testNothingHeardSaysSo() async {
        let engine = FakeEngine()
        engine.finalText = ""
        let s = session(engine)
        s.press()
        await settle()
        s.press()
        XCTAssertEqual(s.phase, .failed("Didn't catch anything."))
    }

    func testEscapeThrowsTheWordsAway() async {
        let engine = FakeEngine()
        var got: [String] = []
        let s = session(engine) { got.append($0) }
        s.press()
        await settle()
        engine.onPartial?("something I changed my mind about")
        s.cancel()
        XCTAssertEqual(s.phase, .idle)
        XCTAssertEqual(s.transcript, "")
        XCTAssertEqual(engine.cancelled, 1)
        XCTAssertEqual(got, [])
    }

    func testPermissionRefusalsAreExplainedAndNeverStartListening() async {
        for (auth, fragment) in [
            (VoiceAuthorization.microphoneDenied, "Microphone"),
            (.speechDenied, "Speech Recognition"),
            (.restricted, "turned off"),
            (.onDeviceUnavailable, "never sends your voice away"),
            (.unavailableHere, "installed Thread app"),
        ] {
            let engine = FakeEngine()
            engine.authorization = auth
            let s = session(engine)
            s.press()
            await settle()
            guard case .failed(let message) = s.phase else { return XCTFail("\(auth) should fail, got \(s.phase)") }
            XCTAssertTrue(message.contains(fragment), "\(auth): \(message)")
            XCTAssertEqual(engine.started, 0, "\(auth) must not start the microphone")
        }
    }

    func testUnsignedInCaptureIsReported() async {
        let engine = FakeEngine()
        engine.finalText = "A real thought with enough words"
        let s = session(engine, accept: false)
        s.press()
        await settle()
        s.press()
        XCTAssertEqual(s.phase, .failed("Open Thread and set it up first, then try again."))
    }

    /// In a test process there are no permission strings, so the real engine must refuse to ask
    /// (asking without them aborts the process).
    func testRealEngineNeverAsksForPermissionOutsideTheInstalledApp() async {
        XCTAssertFalse(AppleSpeechEngine.canAskForPermission)
        let result = await AppleSpeechEngine().authorize()
        XCTAssertEqual(result, .unavailableHere)
    }

    func testShortcutsDoNotCollideWithRecall() {
        for v in VoiceShortcut.allCases where v != .off {
            for r in RecallShortcut.allCases {
                XCTAssertFalse(v.keyCode == r.keyCode && v.carbonModifiers == r.carbonModifiers, "\(v.symbol) collides with \(r.symbol)")
            }
        }
        XCTAssertNil(VoiceShortcut.off.keyCode)
    }
}
