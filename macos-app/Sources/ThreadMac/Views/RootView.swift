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

            if appState.isPaired && appState.isLocked && !inDetail {
                PaywallBanner()
            }

            Group {
                if !appState.isPaired {
                    PairingView()
                } else if inDetail {
                    IdeaDetailView()
                } else {
                    MenuBarListView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if let error = appState.errorMessage, appState.isPaired {
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
        .background(VisualEffectBackground())
        .clipShape(RoundedRectangle(cornerRadius: Theme.corner))
        .task { await appState.refresh() }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .sheet(isPresented: $showPaste) { PasteView() }
        .onExitCommand {
            if inDetail { appState.closeIdea() } else { NSApp.keyWindow?.orderOut(nil) }
        }
    }

    // MARK: header (52pt)

    private var header: some View {
        HStack(spacing: 8) {
            if inDetail {
                HeaderButton(size: 26) { appState.closeIdea() } label: {
                    Image(systemName: "chevron.backward").font(.system(size: 12, weight: .semibold))
                }
                .padding(.leading, -6)
            }
            Text(inDetail ? "Recent" : "Thread")
                .font(.system(size: inDetail ? 13 : 15, weight: inDetail ? .medium : .semibold))
                .foregroundStyle(inDetail ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                .kerning(inDetail ? -0.1 : -0.2)

            Spacer(minLength: 0)

            if appState.isPaired {
                HStack(spacing: 1) {
                    HeaderButton { Task { await appState.refresh() } } label: {
                        Image(systemName: "arrow.clockwise").font(.system(size: 12, weight: .medium))
                    }.help("Refresh")
                    HeaderButton {
                        openWindow(id: "main"); NSApp.activate(ignoringOtherApps: true)
                    } label: {
                        Image(systemName: "macwindow").font(.system(size: 12, weight: .regular))
                    }.help("Open in Window")
                    HeaderButton { showPaste = true } label: {
                        Image(systemName: "plus").font(.system(size: 13, weight: .medium))
                    }.help("Add a conversation")
                    HeaderButton { showSettings = true } label: {
                        Image(systemName: "gearshape").font(.system(size: 12, weight: .regular))
                    }.help("Settings")
                }
            }
        }
        .foregroundStyle(Theme.ink(0.55))
        .padding(.leading, 14)
        .padding(.trailing, 10)
        .frame(height: 52)
    }

    // MARK: footer (26pt)

    private var footer: some View {
        HStack(spacing: 6) {
            Image(systemName: statusIcon).font(.system(size: 10))
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

    private var statusIcon: String {
        switch appState.captureStatus {
        case .capturing: return "icloud.and.arrow.up"
        case .idle: return "icloud"
        case .unpaired: return "exclamationmark.icloud"
        }
    }

    private var statusText: String {
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
