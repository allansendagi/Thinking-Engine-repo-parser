import SwiftUI

struct RootView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.openWindow) private var openWindow
    @State private var showSettings = false
    @State private var showPaste = false

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()

            Group {
                if !appState.isPaired {
                    PairingView()
                } else if appState.selectedIdeaId != nil {
                    IdeaDetailView()
                } else {
                    MenuBarListView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if let error = appState.errorMessage, appState.isPaired {
                Divider()
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
            }

            Divider()
            StatusFooter()
        }
        .frame(width: Theme.panelWidth, height: Theme.panelHeight)
        .background(Theme.panelBackground)
        .task { await appState.refresh() }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .sheet(isPresented: $showPaste) { PasteView() }
        // Escape: step back out of a detail view; from the list, let the panel close itself.
        .onExitCommand {
            if appState.selectedIdeaId != nil { appState.closeIdea() }
            else { NSApp.keyWindow?.orderOut(nil) }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            if appState.selectedIdeaId != nil {
                Button(action: { appState.closeIdea() }) {
                    Image(systemName: "chevron.left")
                }
                .buttonStyle(.plain)
                .help("Back")
            }
            Text("Thread").font(.system(size: 15, weight: .semibold))
            Spacer()
            if appState.isPaired {
                Button(action: { showPaste = true }) { Image(systemName: "plus") }
                    .buttonStyle(.plain)
                    .help("Add a conversation by pasting it")
                Button(action: { Task { await appState.refresh() } }) { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain)
                    .help("Refresh")
                Button(action: { openWindow(id: "main"); NSApp.activate(ignoringOtherApps: true) }) {
                    Image(systemName: "macwindow")
                }
                .buttonStyle(.plain)
                .help("Open in Window")
            }
            Button(action: { showSettings = true }) { Image(systemName: "gearshape") }
                .buttonStyle(.plain)
                .help("Settings")
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }
}

/// "Trustworthy" principle: status is always visible -- account + whether capture is live.
struct StatusFooter: View {
    @EnvironmentObject var appState: AppState

    private var dotColor: Color {
        switch appState.captureStatus {
        case .capturing: return Theme.accent
        case .idle: return .secondary
        case .unpaired: return .orange
        }
    }

    private var captureLabel: String {
        switch appState.captureStatus {
        case .capturing: return "Capturing"
        case .idle: return "Connected"
        case .unpaired: return "Not paired"
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(dotColor).frame(width: 7, height: 7)
            // capture status · privacy mode · idea count -- the three the spec asks to always show
            Text(captureLabel).font(.system(size: 11)).foregroundStyle(.secondary)
            if appState.isPaired {
                dot
                Text(appState.privacyMode).font(.system(size: 11)).foregroundStyle(.secondary)
                if let n = appState.thinkingState?.currentIdeas.count {
                    dot
                    Text("\(n) idea\(n == 1 ? "" : "s")").font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
    }

    private var dot: some View {
        Text("·").font(.system(size: 11)).foregroundStyle(.tertiary)
    }
}
