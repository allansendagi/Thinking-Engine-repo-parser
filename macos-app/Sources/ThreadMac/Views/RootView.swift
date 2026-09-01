import SwiftUI

struct RootView: View {
    @EnvironmentObject var appState: AppState
    @State private var showSettings = false

    var body: some View {
        VStack(spacing: 0) {
            header

            if !appState.isPaired {
                PairingView()
            } else if let error = appState.errorMessage {
                errorBanner(error)
            }

            if appState.isPaired {
                if appState.selectedIdeaId != nil {
                    IdeaDetailView()
                } else {
                    MenuBarListView()
                }
            }
        }
        .frame(width: 360, height: 480)
        .task { await appState.refresh() }
        .sheet(isPresented: $showSettings) { SettingsView() }
    }

    private var header: some View {
        HStack {
            if appState.selectedIdeaId != nil {
                Button(action: { appState.closeIdea() }) { Image(systemName: "chevron.left") }
                    .buttonStyle(.plain)
            }
            Text("Thread").font(.headline)
            Spacer()
            Button(action: { showSettings = true }) { Image(systemName: "gearshape") }
                .buttonStyle(.plain)
        }
        .padding(10)
    }

    private func errorBanner(_ message: String) -> some View {
        Text(message)
            .font(.caption)
            .foregroundColor(.red)
            .padding(.horizontal, 10)
    }
}
