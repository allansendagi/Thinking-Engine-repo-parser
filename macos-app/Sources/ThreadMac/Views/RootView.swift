import SwiftUI

struct RootView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.openWindow) private var openWindow
    @State private var showSettings = false
    @State private var showPaste = false

    private var inDetail: Bool { appState.selectedIdeaId != nil }

    var body: some View {
        VStack(spacing: 0) {
            header

            if appState.showsPaywallBanner && !inDetail {
                PaywallBanner()
            }

            Group {
                if appState.needsReconnect {
                    ReconnectView()
                } else if !appState.isPaired {
                    PairingView()
                } else if inDetail {
                    IdeaDetailView()
                } else {
                    MenuBarListView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if let error = appState.errorMessage, appState.isPaired, !appState.needsReconnect {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 5)
            }

            footer
        }
        .frame(width: Theme.panelWidth, height: Theme.panelHeight)
        .background {
            // Exact demo surface: #F6F6F8 @ 82% over a light frosted material (the mock's
            // rgba(246,246,248,.82) + backdrop-filter blur).
            ZStack {
                VisualEffectBackground()
                Theme.panelTint.opacity(0.82)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: Theme.corner))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.corner)
                .inset(by: 0.25)
                .stroke(Color.white.opacity(0.7), lineWidth: 0.5)   // inset highlight
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.corner)
                .stroke(Color.black.opacity(0.22), lineWidth: 0.5)   // edge hairline
        )
        .preferredColorScheme(.light)  // the design is a light frosted panel, deliberately
        .task { if !appState.needsReconnect { await appState.refresh() } }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .sheet(isPresented: $showPaste) { PasteView() }
        .sheet(item: $appState.transcript) { t in
            ConversationView(transcript: t).environmentObject(appState)
        }
        .sheet(isPresented: Binding(
            get: { appState.showsBackfillSheet },
            set: { if !$0 { appState.hideBackfillSheet() } }
        )) {
            BackfillView().environmentObject(appState)
        }
        .onReceive(NotificationCenter.default.publisher(for: .threadOpenSettings)) { _ in showSettings = true }
        .onReceive(NotificationCenter.default.publisher(for: .threadOpenMainWindow)) { _ in openWindow(id: "main") }
        .onExitCommand {
            if inDetail { appState.closeIdea() }
            else { NotificationCenter.default.post(name: .threadDismissPanel, object: nil) }
        }
    }

    // MARK: header (52pt)

    private var header: some View {
        HStack(spacing: 8) {
            if inDetail {
                HeaderButton(size: 26) { appState.closeIdea() } label: {
                    Glyph(kind: .back, size: 15).foregroundStyle(Theme.ink(0.6))
                }
                .padding(.leading, -6)
            }
            HStack(spacing: 7) {
                if !inDetail {
                    // The plain Thread glyph in dark ink -- no colour, matches the wordmark.
                    Image(nsImage: BrandMark.inkImage)
                        .resizable()
                        .interpolation(.high)
                        .frame(width: 17, height: 17)
                }
                Text(inDetail ? "Recent" : "Thread")
                    .font(.system(size: inDetail ? 13 : 15, weight: inDetail ? .medium : .semibold))
                    .kerning(inDetail ? -0.104 : -0.225)
                    .foregroundStyle(Theme.ink(inDetail ? 0.6 : 0.85))
            }

            Spacer(minLength: 0)

            if appState.isPaired && !appState.needsReconnect {
                HStack(spacing: 1) {
                    HeaderButton { Task { await appState.refresh() } } label: {
                        Glyph(kind: .refresh, size: 15)
                    }.help("Refresh")
                    HeaderButton {
                        openWindow(id: "main")
                        NSApp.activate(ignoringOtherApps: true)
                        NotificationCenter.default.post(name: .threadDismissPanel, object: nil)
                    } label: {
                        Glyph(kind: .window, size: 15)
                    }.help("Open in Window")
                    HeaderButton { showPaste = true } label: {
                        Glyph(kind: .plus, size: 16)
                    }.help("Add a conversation")
                    HeaderButton { showSettings = true } label: {
                        Image(systemName: "gearshape").font(.system(size: 12, weight: .regular))
                    }.help("Settings")
                }
                .foregroundStyle(Theme.ink(0.55))
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 10)
        .frame(height: 52)
    }

    // MARK: footer (26pt)

    private var footer: some View {
        HStack(spacing: 6) {
            Glyph(kind: .cloud, size: 12)
            Text(statusText).font(.system(size: 11))
            Spacer(minLength: 0)
            if let n = appState.thinkingState?.currentIdeas.count {
                Text("\(n) idea\(n == 1 ? "" : "s")")
                    .font(.system(size: 11)).monospacedDigit()
            }
        }
        .foregroundStyle(Theme.ink(0.42))
        .padding(.horizontal, 14)
        .frame(height: 26)
        .overlay(Rectangle().fill(Theme.ink(0.1)).frame(height: 0.5), alignment: .top)
    }

    private var statusText: String {
        if appState.needsReconnect { return "Reconnect to sync" }
        switch appState.captureStatus {
        case .capturing: return "Capturing"
        case .idle: return appState.lastExtensionHandshake == nil ? "Connected" : "Updated just now"
        case .unpaired: return "Not paired"
        }
    }
}

/// A 28pt square header icon button with a soft hover fill (the mock's toolbar buttons).
struct HeaderButton<Label: View>: View {
    var size: CGFloat = 28
    let action: () -> Void
    @ViewBuilder let label: Label
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            label
                .frame(width: size, height: size)
                .background(hover ? Theme.ink(0.07) : .clear, in: RoundedRectangle(cornerRadius: 6))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}
