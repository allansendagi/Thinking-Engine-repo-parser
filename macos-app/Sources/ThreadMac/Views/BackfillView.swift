import SwiftUI

/// "Recover my thinking" — turn a ChatGPT / Claude data export into ideas. A functional pass;
/// the polished first-run version is a separate step. Driven by `appState.backfill`.
struct BackfillView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch appState.backfill {
            case .idle:
                EmptyView()
            case .offered(let exports):
                offer(exports)
            case .running(let p):
                running(p)
            case .finished(let ideaCount, let newIdeas):
                result(title: "Your thinking is taking shape",
                       line: "\(newIdeas) idea\(newIdeas == 1 ? "" : "s") recovered from your history — \(ideaCount) in Thread now.",
                       showUpgrade: false)
            case .partial(let ideaCount, let newIdeas):
                result(title: "Recovered \(newIdeas) idea\(newIdeas == 1 ? "" : "s")",
                       line: "You've hit the Free plan's 25-idea limit at \(ideaCount). Pro recovers the rest of your history.",
                       showUpgrade: true)
            case .failed(let msg):
                result(title: "That import didn't finish", line: msg, showUpgrade: false)
            }
        }
        .padding(18)
        .frame(width: 380)
    }

    // MARK: offer

    @ViewBuilder
    private func offer(_ exports: [DetectedExport]) -> some View {
        Text("Recover your thinking")
            .font(.headline)
        Text("Thread can reconstruct the ideas, decisions and open questions from AI conversations you've already had.")
            .font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)

        if appState.cursorBackfillAvailable {
            Button { appState.runCursorBackfill() } label: {
                HStack(spacing: 8) {
                    Image(systemName: "sparkles").foregroundStyle(Theme.accent)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Recover from Cursor").font(.system(size: 12, weight: .medium))
                        Text("Your local Cursor history — no export needed").font(.caption2).foregroundColor(.secondary)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.system(size: 10)).foregroundColor(.secondary)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }

        if exports.isEmpty {
            Button {
                appState.lookForExports()
            } label: {
                Label("I have a ChatGPT / Claude export in Downloads — check", systemImage: "folder")
                    .font(.system(size: 12, weight: .medium))
            }
            .buttonStyle(.borderedProminent)
        }

        VStack(spacing: 6) {
            ForEach(exports.prefix(3)) { e in
                Button { appState.runBackfill(e) } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "sparkles").foregroundStyle(Theme.accent)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Recover from your \(e.kind.displayName) export").font(.system(size: 12, weight: .medium))
                            Text("~\(e.conversationCount) conversations · \(Theme.ago(e.modified))")
                                .font(.caption2).foregroundColor(.secondary)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.system(size: 10)).foregroundColor(.secondary)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }

        Divider()

        Text("Don't have an export yet?")
            .font(.caption2).foregroundColor(.secondary)
        HStack(spacing: 8) {
            ForEach(BackfillKind.allCases, id: \.self) { k in
                Button("\(k.displayName) export →") { appState.openExportPage(k) }
                    .font(.caption2).buttonStyle(.plain).foregroundStyle(Theme.accent)
            }
        }
        Text("Request it there — the provider emails a link. When the file lands in Downloads, Thread picks it up automatically.")
            .font(.caption2).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)

        Button("Not now") { appState.dismissBackfillOffer() }
            .controlSize(.small).foregroundColor(.secondary)
    }

    // MARK: running

    @ViewBuilder
    private func running(_ p: BackfillProgress) -> some View {
        Text("Reconstructing your thinking…").font(.headline)
        ProgressView(value: Double(p.conversationsDone), total: Double(max(p.conversationsTotal, 1)))
            .tint(Theme.accent)
        HStack {
            Text("\(p.conversationsDone) of \(p.conversationsTotal) conversations")
            Spacer()
            Text("\(p.ideaCount) idea\(p.ideaCount == 1 ? "" : "s")").monospacedDigit()
        }
        .font(.caption).foregroundColor(.secondary)
        Text("You can close this — it keeps working in the background.")
            .font(.caption2).foregroundColor(.secondary)
        Button("Hide") { appState.hideBackfillSheet() }
            .controlSize(.small).foregroundColor(.secondary)
    }

    // MARK: result

    @ViewBuilder
    private func result(title: String, line: String, showUpgrade: Bool) -> some View {
        Text(title).font(.headline)
        Text(line).font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
        HStack {
            if showUpgrade {
                Button("Upgrade to Pro") { appState.openUpgradePage() }
                    .buttonStyle(.borderedProminent)
            }
            Button("Done") { appState.dismissBackfillOffer() }
        }
        .padding(.top, 2)
    }
}
