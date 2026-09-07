import XCTest
@testable import ThreadMac

// MARK: - a hand-built AX tree

/// In-memory `AXNode` so the whole sensor runs in CI -- no Accessibility permission, no Cursor.
final class FakeAXNode: AXNode {
    var axRole: String
    var axSubrole: String?
    var axTitle: String?
    var axDescription: String?
    var axIdentifier: String?
    var axValue: String?
    private var kids: [FakeAXNode]

    init(
        _ role: String,
        value: String? = nil,
        identifier: String? = nil,
        description: String? = nil,
        title: String? = nil,
        subrole: String? = nil,
        children: [FakeAXNode] = []
    ) {
        self.axRole = role
        self.axValue = value
        self.axIdentifier = identifier
        self.axDescription = description
        self.axTitle = title
        self.axSubrole = subrole
        self.kids = children
    }

    var axChildren: [AXNode] { kids }

    func axString(_ attribute: String) -> String? {
        switch attribute {
        case AXAttribute.role: return axRole
        case AXAttribute.subrole: return axSubrole
        case AXAttribute.title: return axTitle
        case AXAttribute.description: return axDescription
        case AXAttribute.identifier: return axIdentifier
        case AXAttribute.value: return axValue
        default: return nil
        }
    }
}

/// A Cursor-ish tree: a window, a sidebar to ignore, and a chat scroll area holding one AXGroup
/// per turn with an AXStaticText leaf. `tagged` puts a role hint on the group's identifier.
private func cursorTree(_ turns: [(role: String, text: String)], tagged: Bool, key: String = "chat") -> FakeAXNode {
    let bubbles = turns.map { turn in
        FakeAXNode(
            "AXGroup",
            identifier: tagged ? "message-\(turn.role)" : nil,
            children: [FakeAXNode("AXStaticText", value: turn.text)]
        )
    }
    let chat = FakeAXNode("AXScrollArea", identifier: "aichat-\(key)", children: bubbles)
    let sidebar = FakeAXNode("AXGroup", identifier: "explorer", children: [
        FakeAXNode("AXStaticText", value: "src"), FakeAXNode("AXStaticText", value: "README.md"),
    ])
    let window = FakeAXNode("AXWindow", subrole: "AXStandardWindow", children: [sidebar, chat])
    return FakeAXNode("AXApplication", children: [window])
}

// MARK: - tests

final class AXConversationSensorTests: XCTestCase {
    private let adapter = CursorAXAdapter()
    private let t0 = Date(timeIntervalSince1970: 1_760_000_000)

    private func convo(_ turns: [(role: String, text: String)], tagged: Bool = true, key: String = "chat") -> AXConversationObservation {
        let tree = cursorTree(turns, tagged: tagged, key: key)
        guard let root = adapter.conversationRoot(appRoot: tree) else {
            return AXConversationObservation(conversationKey: "none", blocks: [])
        }
        return AXConversationObservation(
            conversationKey: adapter.conversationKey(root: root, appRoot: tree) ?? "none",
            blocks: adapter.messageBlocks(root: root)
        )
    }

    // adapter ------------------------------------------------------------------

    func testFindsTheChatContainerNotTheSidebar() {
        let tree = cursorTree([("user", "hello there friend"), ("assistant", "hi, how can I help")], tagged: true)
        let root = adapter.conversationRoot(appRoot: tree)
        XCTAssertEqual((root as? FakeAXNode)?.axIdentifier, "aichat-chat")
    }

    func testExplicitRolesWhenTagged() {
        let obs = convo([
            ("user", "what is the capture architecture"),
            ("assistant", "three epistemic levels that never blur"),
            ("user", "and identity resolution"),
        ], tagged: true)
        XCTAssertEqual(obs.blocks.map(\.role), ["user", "assistant", "user"])
        XCTAssertTrue(obs.blocks.allSatisfy { $0.roleConfidence == .explicit })
    }

    func testAlternationFallbackWhenUntagged() {
        let obs = convo([
            ("user", "first turn is always the user in cursor"),
            ("assistant", "so alternate from there"),
            ("user", "third turn user again"),
            ("assistant", "fourth assistant"),
        ], tagged: false)
        XCTAssertEqual(obs.blocks.map(\.role), ["user", "assistant", "user", "assistant"])
        XCTAssertTrue(obs.blocks.allSatisfy { $0.roleConfidence == .inferred })
    }

    func testConversationKeyIsTheStablePaneHandleNotTheFirstVisibleTurn() {
        // Same pane, grown by a turn -> same key. Different pane -> different key. The first
        // turn's text is deliberately identical across the two panes to prove the key doesn't
        // depend on it (that's what survives virtualization).
        let a1 = convo([("user", "identical opening line here"), ("assistant", "an answer here")], key: "paneA")
        let a2 = convo([("user", "identical opening line here"), ("assistant", "an answer here"), ("user", "a follow up now")], key: "paneA")
        let b = convo([("user", "identical opening line here"), ("assistant", "an answer here")], key: "paneB")
        XCTAssertEqual(a1.conversationKey, a2.conversationKey)
        XCTAssertNotEqual(a1.conversationKey, b.conversationKey)
    }

    func testConversationKeyFallsBackToFirstTurnHashWhenPaneHasNoHandle() {
        // A container identified only by its description keyword, no identifier/title -> the key
        // has to come from the first turn (and this IS the fragile case, by design).
        let bubbles = [("user", "opener line of the thread"), ("assistant", "reply line of the thread")].map {
            FakeAXNode("AXGroup", identifier: "message-\($0.0)", children: [FakeAXNode("AXStaticText", value: $0.1)])
        }
        let chat = FakeAXNode("AXScrollArea", description: "chat transcript", children: bubbles)
        let app = FakeAXNode("AXApplication", children: [FakeAXNode("AXWindow", children: [chat])])
        let root = adapter.conversationRoot(appRoot: app)
        XCTAssertNotNil(root)
        XCTAssertEqual(adapter.conversationKey(root: root!, appRoot: app), AXText.shortHash("opener line of the thread"))
    }

    func testShortTurnIsKeptWhenTagged() {
        let tagged = convo([("user", "is it on"), ("assistant", "yes")], tagged: true)
        XCTAssertEqual(tagged.blocks.map(\.text), ["is it on", "yes"], "a role hint keeps a turn that's too short to stand on its own")
    }

    // identity ---------------------------------------------------------------

    func testMessageIDIsContentDerivedNotElementDerived() {
        // Two independently built trees, same turns -> same ids (survives a virtualized rebuild).
        let one = convo([("user", "stable identity across an element rebuild"), ("user", "second line of it")])
        let two = convo([("user", "stable identity across an element rebuild"), ("user", "second line of it")])
        var s1 = AXSensorState(), s2 = AXSensorState()
        let r1 = AXConversationSensor.step(observation: one, now: t0, state: &s1)
        let r2 = AXConversationSensor.step(observation: two, now: t0, state: &s2)
        XCTAssertEqual(r1.settled.map(\.id), r2.settled.map(\.id))
        XCTAssertEqual(r1.settled.count, 2)
    }

    // step: streaming tail --------------------------------------------------

    func testTrailingAssistantTurnIsHeldUntilStable() {
        var state = AXSensorState()
        let partial = convo([("user", "explain it"), ("assistant", "three epi")])
        let r1 = AXConversationSensor.step(observation: partial, now: t0, state: &state)
        XCTAssertEqual(r1.settled.map(\.role), ["user"], "the streaming assistant turn is withheld")
        XCTAssertTrue(r1.holdingStreamingTail)

        // Text still moving a moment later -> still held.
        let moving = convo([("user", "explain it"), ("assistant", "three epistemic")])
        let r2 = AXConversationSensor.step(observation: moving, now: t0.addingTimeInterval(0.3), state: &state)
        XCTAssertTrue(r2.settled.isEmpty)
        XCTAssertTrue(r2.holdingStreamingTail)

        // Same text, long enough -> it settles.
        let settledObs = convo([("user", "explain it"), ("assistant", "three epistemic")])
        let r3 = AXConversationSensor.step(observation: settledObs, now: t0.addingTimeInterval(1.5), state: &state)
        XCTAssertEqual(r3.settled.map(\.role), ["assistant"])
        XCTAssertFalse(r3.holdingStreamingTail)
    }

    func testTrailingUserTurnSettlesImmediately() {
        var state = AXSensorState()
        let obs = convo([
            ("user", "first question of the thread"),
            ("assistant", "the assistant answer is complete"),
            ("user", "and here is my next question"),
        ])
        let r = AXConversationSensor.step(observation: obs, now: t0, state: &state)
        XCTAssertEqual(r.settled.map(\.role), ["user", "assistant", "user"])
        XCTAssertFalse(r.holdingStreamingTail)
    }

    // step: incremental ---------------------------------------------------

    func testOnlyNewTurnsEmitOnReObservation() {
        var state = AXSensorState()
        let obs = convo([("user", "kickoff question here"), ("assistant", "an answer"), ("user", "follow up question")])
        _ = AXConversationSensor.step(observation: obs, now: t0, state: &state)
        let again = AXConversationSensor.step(observation: obs, now: t0.addingTimeInterval(2), state: &state)
        XCTAssertTrue(again.settled.isEmpty, "nothing new the second time")
    }

    func testNewTurnAfterSettleEmitsExactlyIt() {
        var state = AXSensorState()
        let first = convo([("user", "kickoff question here"), ("assistant", "the first answer"), ("user", "a follow up question")])
        let r0 = AXConversationSensor.step(observation: first, now: t0, state: &state)
        XCTAssertEqual(r0.settled.count, 3)

        // A new assistant turn appears and streams -> held on this scan...
        let grown = convo([
            ("user", "kickoff question here"), ("assistant", "the first answer"),
            ("user", "a follow up question"), ("assistant", "the follow up answer is here"),
        ])
        let held = AXConversationSensor.step(observation: grown, now: t0.addingTimeInterval(2), state: &state)
        XCTAssertTrue(held.settled.isEmpty)
        XCTAssertTrue(held.holdingStreamingTail)

        // ...then its text stops moving and it settles, alone.
        let done = AXConversationSensor.step(observation: grown, now: t0.addingTimeInterval(4), state: &state)
        XCTAssertEqual(done.settled.map(\.text), ["the follow up answer is here"])
    }

    func testVirtualizedPrefixDropDoesNotReEmit() {
        var state = AXSensorState()
        let full = convo([
            ("user", "turn a full sentence"), ("assistant", "turn b full sentence"),
            ("user", "turn c full sentence"), ("user", "turn d full sentence"),
        ])
        let r1 = AXConversationSensor.step(observation: full, now: t0, state: &state)
        XCTAssertEqual(r1.settled.count, 4)

        // Cursor recycled the first two bubbles off-screen; a new turn e arrived.
        let windowed = convo([
            ("user", "turn c full sentence"), ("user", "turn d full sentence"),
            ("user", "turn e full sentence"),
        ])
        let r2 = AXConversationSensor.step(observation: windowed, now: t0.addingTimeInterval(2), state: &state)
        XCTAssertEqual(r2.settled.map(\.text), ["turn e full sentence"])
    }

    // step: conversation change ----------------------------------------

    func testConversationChangeResetsAndSignals() {
        var state = AXSensorState()
        let a = convo([("user", "first conversation opener line"), ("user", "second line here in it")], key: "a")
        let ra = AXConversationSensor.step(observation: a, now: t0, state: &state)
        XCTAssertEqual(ra.conversationChangedTo, a.conversationKey)
        XCTAssertEqual(ra.settled.count, 2)

        let b = convo([("user", "a brand new conversation opener"), ("user", "its own second line here")], key: "b")
        let rb = AXConversationSensor.step(observation: b, now: t0.addingTimeInterval(5), state: &state)
        XCTAssertEqual(rb.conversationChangedTo, b.conversationKey)
        XCTAssertEqual(rb.settled.count, 2, "the new conversation's turns emit fresh, not suppressed by the old set")
        XCTAssertNotEqual(a.conversationKey, b.conversationKey)
    }

    // fidelity ----------------------------------------------------------

    func testInferredRolesDragBatchFidelityToMedium() {
        var state = AXSensorState()
        let obs = convo([("user", "untagged one sentence"), ("user", "untagged two sentence")], tagged: false)
        let r = AXConversationSensor.step(observation: obs, now: t0, state: &state)
        XCTAssertEqual(AXConversationSensor.batchFidelity(r.settled), "medium")
    }

    func testExplicitRolesKeepBatchFidelityHigh() {
        var state = AXSensorState()
        let obs = convo([("user", "tagged one sentence"), ("user", "tagged two sentence")], tagged: true)
        let r = AXConversationSensor.step(observation: obs, now: t0, state: &state)
        XCTAssertEqual(AXConversationSensor.batchFidelity(r.settled), "high")
    }

    // text ------------------------------------------------------------

    func testNormalizeCollapsesWhitespace() {
        XCTAssertEqual(AXText.normalize("  hello\n\n  world \t of  capture "), "hello world of capture")
    }

    func testEmptyObservationYieldsNothing() {
        var state = AXSensorState()
        let obs = AXConversationObservation(conversationKey: "k", blocks: [])
        let r = AXConversationSensor.step(observation: obs, now: t0, state: &state)
        XCTAssertEqual(r.conversationChangedTo, "k", "the key change still registers")
        XCTAssertTrue(r.settled.isEmpty)
    }
}

#if canImport(ApplicationServices) && canImport(AppKit)
final class AXSensorRunnerSmokeTests: XCTestCase {
    /// In CI the test process is not Accessibility-trusted and Cursor isn't running, so `start()`
    /// must land on a not-watching status and never call `ingest`. This just proves the live
    /// driver links and its guards hold; real behavior is the manual harness.
    @MainActor
    func testStartWithoutPermissionOrAppEmitsNothing() {
        var ingestCalls = 0
        let runner = AXSensorRunner(
            adapter: CursorAXAdapter(),
            bundleID: "com.todesktop.230313mzl4w4u92",
            ingest: { _, _, _ in ingestCalls += 1 }
        )
        runner.start()
        switch runner.status {
        case .needsPermission, .appNotRunning, .error:
            break  // all acceptable on a headless runner
        default:
            XCTFail("unexpected status \(runner.status)")
        }
        XCTAssertEqual(ingestCalls, 0)
        runner.stop()
    }
}
#endif
