import Foundation

/// Native continuation -- point 3 of the native launch gate: deliver the continuation checkpoint
/// straight into a native AI app's message composer instead of leaving it on the clipboard for
/// the user to paste.
///
/// User-initiated only -- a "Continue in <app>" menu item, never automatic. Fails closed: every
/// outcome other than `.delivered` means the caller runs the clipboard + bring-forward path, and
/// nothing here retries or reaches for a different element. The draft guard mirrors the browser
/// extension's `fillComposer` (PR #48): never overwrite text the user has already typed.
///
/// `place` is pure over the AX tree so CI exercises it against a fake app. The running-app lookup
/// and window activation live in the caller (`AppState.continueInNativeApp`) and are untested,
/// like the rest of the live AX layer.
enum NativeContinuation {
    enum Outcome: Equatable {
        case delivered      // written into the composer
        case noComposer     // the adapter found no composer in this tree
        case draftPresent   // the composer already holds text -- left untouched
        case notWritable    // AX reports kAXValueAttribute isn't settable here (bridged contenteditable)
        case writeRejected  // settable, but the write call itself failed
    }

    static func place(text: String, appRoot: AXNode, adapter: any AXConversationAdapter) -> Outcome {
        guard let composer = adapter.composerElement(appRoot: appRoot) else { return .noComposer }
        if let existing = composer.axValue?.trimmingCharacters(in: .whitespacesAndNewlines), !existing.isEmpty {
            return .draftPresent
        }
        guard composer.axIsValueSettable else { return .notWritable }
        return composer.setValue(text) ? .delivered : .writeRejected
    }
}
