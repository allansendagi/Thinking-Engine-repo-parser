import XCTest
@testable import ThreadMac

/// `NativeContinuation.place` -- the pure part of native continuation (point 3). The running-app
/// lookup and window activation in `AppState.continueInNativeApp` aren't covered here (live AX
/// layer); the placement logic that decides delivered / draft / not-writable / no-composer is.
final class NativeContinuationTests: XCTestCase {
    private let adapter = AXAdapters.claude

    /// A Claude-ish tree: a chat pane plus a composer text area. `settable` controls whether the
    /// composer will accept a value write; `draft` seeds it with existing text.
    private func tree(draft: String? = nil, settable: Bool = true, withComposer: Bool = true) -> FakeAXNode {
        var kids: [FakeAXNode] = [
            FakeAXNode("AXWebArea", identifier: "chat", children: [
                FakeAXNode("AXStaticText", value: "an earlier user turn, long enough to count", identifier: "message-user"),
                FakeAXNode("AXStaticText", value: "claude replied here at some length", identifier: "message-assistant"),
            ]),
        ]
        if withComposer {
            let composer = FakeAXNode("AXTextArea", value: draft, description: "Send a message")
            composer.settable = settable
            kids.append(composer)
        }
        return FakeAXNode("AXApplication", children: [FakeAXNode("AXWindow", children: kids)])
    }

    private func composer(in t: FakeAXNode) -> FakeAXNode? {
        t.flattened().first { $0.axRole == "AXTextArea" } as? FakeAXNode
    }

    func testWritesTheHandoffIntoAnEmptyComposer() {
        let t = tree()
        XCTAssertEqual(
            NativeContinuation.place(text: "pick up exactly here", appRoot: t, adapter: adapter),
            .delivered
        )
        XCTAssertEqual(composer(in: t)?.written, ["pick up exactly here"])
    }

    func testLeavesAnExistingDraftUntouched() {
        let t = tree(draft: "half a thought I was still typing")
        XCTAssertEqual(
            NativeContinuation.place(text: "pick up here", appRoot: t, adapter: adapter),
            .draftPresent
        )
        XCTAssertEqual(composer(in: t)?.written, [])  // nothing written over the user's text
    }

    func testReportsWhenTheComposerWontTakeAValueWrite() {
        // The realistic case for a bridged contenteditable -- caller must fall back, not silently no-op.
        let t = tree(settable: false)
        XCTAssertEqual(NativeContinuation.place(text: "x", appRoot: t, adapter: adapter), .notWritable)
        XCTAssertEqual(composer(in: t)?.written, [])
    }

    func testReportsWhenThereIsNoComposer() {
        let t = tree(withComposer: false)
        XCTAssertEqual(NativeContinuation.place(text: "x", appRoot: t, adapter: adapter), .noComposer)
    }

    func testWhitespaceOnlyDraftIsNotTreatedAsADraft() {
        let t = tree(draft: "   \n  ")
        XCTAssertEqual(
            NativeContinuation.place(text: "go on from here", appRoot: t, adapter: adapter),
            .delivered
        )
        XCTAssertEqual(composer(in: t)?.written, ["go on from here"])
    }

    /// A bare text area with no composer hint -- the find bar, an editor pane, a terminal -- must
    /// never be picked as the write target. The checkpoint would land in a source file.
    func testIgnoresAnUnhintedTextAreaEvenWhenItComesFirstInTheTree() {
        let findBar = FakeAXNode("AXTextField", description: "Find in file")
        findBar.settable = true
        let editor = FakeAXNode("AXTextArea", value: "func main() {}", identifier: "editor-pane")
        editor.settable = true
        let composer = FakeAXNode("AXTextArea", description: "Send a message")
        composer.settable = true
        let chat = FakeAXNode("AXWebArea", identifier: "chat", children: [
            FakeAXNode("AXStaticText", value: "an earlier user turn, long enough to count"),
            FakeAXNode("AXStaticText", value: "the assistant answered here at length"),
        ])
        let t = FakeAXNode("AXApplication", children: [
            FakeAXNode("AXWindow", children: [findBar, editor, chat, composer]),
        ])

        XCTAssertEqual(NativeContinuation.place(text: "continue here", appRoot: t, adapter: adapter), .delivered)
        XCTAssertEqual(composer.written, ["continue here"])
        XCTAssertEqual(findBar.written, [])
        XCTAssertEqual(editor.written, [])
    }

    func testNoComposerWhenEveryTextAreaIsUnhinted() {
        let editor = FakeAXNode("AXTextArea", value: "func main() {}", identifier: "editor-pane")
        editor.settable = true
        let t = FakeAXNode("AXApplication", children: [FakeAXNode("AXWindow", children: [editor])])
        XCTAssertEqual(NativeContinuation.place(text: "x", appRoot: t, adapter: adapter), .noComposer)
        XCTAssertEqual(editor.written, [])
    }
}
