import AppKit
import SwiftUI

/// "Thread" in the Share menu of any app that shares text: select some text, Share, Thread. It drops the
/// text into the shared inbox (ShareInbox.swift) for the Thread app to capture, shows a short
/// confirmation, and closes. It never touches the network and reads only what is being shared.
@objc(ShareViewController)
final class ShareViewController: NSViewController {
    private let model = ShareModel()

    override func loadView() {
        let host = NSHostingView(rootView: ShareView(model: model) { [weak self] in
            self?.extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
        })
        host.frame = NSRect(x: 0, y: 0, width: 320, height: 124)
        view = host
        preferredContentSize = host.frame.size
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        Task { @MainActor in
            let (text, from) = await Self.sharedText(from: extensionContext)
            if ShareInbox.write(text: text, from: from) {
                model.phase = .added
                try? await Task.sleep(nanoseconds: 900_000_000)
                extensionContext?.completeRequest(returningItems: nil)
            } else {
                model.phase = ShareInbox.wordCount(text) < ShareInbox.minimumWords ? .tooShort : .unreachable
            }
        }
    }

    /// The plain text being shared: a text attachment, or the item's attributed content as a fallback.
    private static func sharedText(from context: NSExtensionContext?) async -> (String, String?) {
        let items = (context?.inputItems as? [NSExtensionItem]) ?? []
        for item in items {
            for provider in item.attachments ?? [] where provider.hasItemConformingToTypeIdentifier("public.plain-text") {
                if let value = try? await provider.loadItem(forTypeIdentifier: "public.plain-text") {
                    if let s = value as? String, !s.isEmpty { return (s, item.attributedTitle?.string) }
                    if let s = value as? NSAttributedString, s.length > 0 { return (s.string, item.attributedTitle?.string) }
                    if let d = value as? Data, let s = String(data: d, encoding: .utf8), !s.isEmpty { return (s, item.attributedTitle?.string) }
                }
            }
            if let s = item.attributedContentText?.string, !s.isEmpty { return (s, item.attributedTitle?.string) }
        }
        return ("", nil)
    }
}

@MainActor
final class ShareModel: ObservableObject {
    enum Phase { case working, added, tooShort, unreachable }
    @Published var phase: Phase = .working
}

struct ShareView: View {
    @ObservedObject var model: ShareModel
    let done: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            switch model.phase {
            case .working:
                ProgressView().controlSize(.small)
                Text("Adding to Thread…").font(.system(size: 13))
            case .added:
                Image(systemName: "checkmark.circle.fill").font(.system(size: 30)).foregroundStyle(Color.accentColor)
                Text("Added to Thread").font(.system(size: 13, weight: .semibold))
            case .tooShort:
                Text("That's a bit short").font(.system(size: 13, weight: .semibold))
                Text("Select a few words or more to add to Thread.").font(.system(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Button("OK", action: done).keyboardShortcut(.defaultAction)
            case .unreachable:
                Text("Couldn't reach Thread").font(.system(size: 13, weight: .semibold))
                Text("Open Thread once, then try again.").font(.system(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Button("OK", action: done).keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 320, height: 124)
        .accessibilityElement(children: .contain)
    }
}
