import AppKit
import SwiftUI

/// The small panel that shows while Thread is listening: the words as they're understood, and how to
/// finish. It floats above whatever you're doing without taking focus from it, like the recall panel.
struct VoiceHUDView: View {
    @ObservedObject var session: VoiceSession
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                indicator
                Text(title).font(.system(size: 13, weight: .semibold)).kerning(-0.08)
                Spacer(minLength: 0)
                if case .listening = session.phase {
                    Text("Esc to cancel").font(.system(size: 11)).foregroundStyle(Theme.ink(0.4))
                }
            }
            if !session.transcript.isEmpty || session.phase == .listening {
                Text(session.transcript.isEmpty ? "Say what you're thinking…" : session.transcript)
                    .font(.system(size: 14)).lineSpacing(2)
                    .foregroundStyle(session.transcript.isEmpty ? Theme.ink(0.35) : Theme.ink(0.88))
                    .lineLimit(5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if case .listening = session.phase {
                Text("Press \(VoiceShortcut.current.symbol) again, or release it, to capture")
                    .font(.system(size: 11)).foregroundStyle(Theme.ink(0.4))
            }
            if case .failed(let message) = session.phase {
                Text(message).font(.system(size: 12)).foregroundStyle(Theme.ink(0.62))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(16)
        .frame(width: 380, alignment: .leading)
        .background(Theme.panelTint.opacity(0.96))
        .background(VisualEffectBackground(material: .hudWindow))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.edgeHairline.opacity(0.5), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.25), radius: 18, y: 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
        .accessibilityValue(session.transcript)
    }

    private var title: String {
        switch session.phase {
        case .requesting: return "Getting ready…"
        case .listening: return "Listening"
        case .finishing: return "Capturing…"
        case .captured: return "Captured in Thread"
        case .failed: return "Couldn't capture"
        case .idle: return ""
        }
    }

    @ViewBuilder private var indicator: some View {
        switch session.phase {
        case .captured:
            Image(systemName: "checkmark.circle.fill").font(.system(size: 16)).foregroundStyle(Theme.accent)
        case .failed:
            Image(systemName: "exclamationmark.circle.fill").font(.system(size: 16)).foregroundStyle(Theme.stateColor("contested"))
        default:
            ZStack {
                Circle().fill(Theme.accent.opacity(0.18))
                    .frame(width: 26, height: 26)
                    .scaleEffect(reduceMotion ? 1 : 1 + CGFloat(session.level) * 0.5)
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.08), value: session.level)
                Image(systemName: "mic.fill").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.accent)
            }
            .frame(width: 26, height: 26)
        }
    }
}

/// Owns the panel: appears when a session becomes active or has something to say, disappears when
/// it goes idle.
@MainActor
final class VoiceHUDController {
    private let session: VoiceSession
    private var panel: NSPanel?
    private var observer: Any?   // the Combine subscription; held for the controller's lifetime

    init(session: VoiceSession) {
        self.session = session
        observer = session.$phase.receive(on: RunLoop.main).sink { [weak self] phase in
            MainActor.assumeIsolated { self?.update(phase) }
        }
    }

    private func update(_ phase: VoiceSession.Phase) {
        if phase == .idle { hide() } else { show() }
    }

    private func show() {
        let p = panel ?? makePanel()
        panel = p
        let size = p.contentView?.fittingSize ?? NSSize(width: 380, height: 120)
        p.setContentSize(size)
        if let screen = NSScreen.main {
            let f = screen.visibleFrame
            p.setFrameOrigin(NSPoint(x: f.midX - size.width / 2, y: f.maxY - size.height - 18))
        }
        p.orderFrontRegardless()
    }

    private func hide() { panel?.orderOut(nil) }

    private func makePanel() -> NSPanel {
        let host = NSHostingView(rootView: VoiceHUDView(session: session))
        host.frame = NSRect(x: 0, y: 0, width: 380, height: 120)
        let p = NSPanel(contentRect: host.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isFloatingPanel = true
        p.level = .floating
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        p.contentView = host
        return p
    }
}
