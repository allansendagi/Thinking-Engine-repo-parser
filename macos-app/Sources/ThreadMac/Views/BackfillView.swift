import SwiftUI

/// "Recover my thinking" — the first-run experience: offer → a staged "finding your thinking"
/// pass → the graph it reconstructed, led by one strong idea. Driven by `appState.backfill`.
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
            case .finished(let summary, let capped):
                finished(summary, capped: capped)
            case .failed(let msg):
                VStack(alignment: .leading, spacing: 10) {
                    Text("That import didn't finish").font(.headline)
                    Text(msg).font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
                    Button("Done") { appState.dismissBackfillOffer() }
                }
            }
        }
        .padding(18)
        .frame(width: 400)
    }

    // MARK: offer

    @ViewBuilder
    private func offer(_ exports: [DetectedExport]) -> some View {
        Text("Recover your thinking").font(.headline)
        Text("Thread doesn't start with a blank page — it can reconstruct the ideas, decisions and open questions from AI conversations you've already had.")
            .font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)

        if appState.cursorBackfillAvailable {
            sourceRow("Recover from Cursor", "Your local Cursor history — no export needed") { appState.runCursorBackfill() }
        }

        ForEach(exports.prefix(3)) { e in
            sourceRow("Recover from your \(e.kind.displayName) export",
                      "~\(e.conversationCount) conversations · \(Theme.ago(e.modified))") { appState.runBackfill(e) }
        }

        if exports.isEmpty {
            Button { appState.lookForExports() } label: {
                Label("I have a ChatGPT / Claude export in Downloads — check", systemImage: "folder")
                    .font(.system(size: 12, weight: .medium))
            }
            .buttonStyle(.borderedProminent)
        }

        Divider()

        Text("Don't have an export yet?").font(.caption2).foregroundColor(.secondary)
        HStack(spacing: 10) {
            ForEach(BackfillKind.allCases, id: \.self) { k in
                Button("\(k.displayName) export →") { appState.openExportPage(k) }
                    .font(.caption2).buttonStyle(.plain).foregroundStyle(Theme.accent)
            }
        }
        Text("The provider emails a link. When the file lands in Downloads, Thread picks it up automatically.")
            .font(.caption2).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)

        Button("Not now") { appState.dismissBackfillOffer() }
            .controlSize(.small).foregroundColor(.secondary)
    }

    private func sourceRow(_ title: String, _ sub: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "sparkles").foregroundStyle(Theme.accent)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.system(size: 12, weight: .medium))
                    Text(sub).font(.caption2).foregroundColor(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.system(size: 10)).foregroundColor(.secondary)
            }
            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: running — "Finding your thinking…"

    private static let phases = [
        "Reading conversations",
        "Finding recurring ideas",
        "Reconstructing how they evolved",
        "Surfacing unfinished threads",
        "Connecting related thinking",
    ]

    @ViewBuilder
    private func running(_ p: BackfillProgress) -> some View {
        Text("Finding your thinking…").font(.headline)

        let frac = p.conversationsTotal > 0 ? Double(p.conversationsDone) / Double(p.conversationsTotal) : 0
        let activeIdx = min(Int(frac * Double(Self.phases.count)), Self.phases.count - 1)

        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(Self.phases.enumerated()), id: \.offset) { i, name in
                HStack(spacing: 7) {
                    if i < activeIdx || (frac >= 1 && i <= activeIdx) {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.accent)
                    } else if i == activeIdx {
                        ProgressView().controlSize(.small).frame(width: 13, height: 13)
                    } else {
                        Image(systemName: "circle").foregroundStyle(Theme.ink(0.2))
                    }
                    Text(name)
                        .font(.system(size: 12))
                        .foregroundStyle(i <= activeIdx ? Theme.ink(0.8) : Theme.ink(0.4))
                }
            }
        }
        .padding(.vertical, 2)

        ProgressView(value: Double(p.conversationsDone), total: Double(max(p.conversationsTotal, 1)))
            .tint(Theme.accent)
        HStack {
            Text(p.conversationsTotal > 0 ? "\(p.conversationsDone) of \(p.conversationsTotal) conversations" : "\(p.conversationsDone) conversations")
            Spacer()
            Text("\(p.ideaCount) idea\(p.ideaCount == 1 ? "" : "s")").monospacedDigit()
        }
        .font(.caption).foregroundColor(.secondary)

        Button("Close — keeps working in the background") { appState.hideBackfillSheet() }
            .controlSize(.small).foregroundColor(.secondary)
    }

    // MARK: finished — the reconstructed graph

    @ViewBuilder
    private func finished(_ s: AppState.BackfillSummary, capped: Bool) -> some View {
        Text(s.newIdeas > 0 ? "Your thinking is taking shape" : "Nothing new to recover")
            .font(.headline)
        if s.newIdeas > 0 {
            Text("\(s.newIdeas) idea\(s.newIdeas == 1 ? "" : "s") recovered from your history.")
                .font(.caption).foregroundColor(.secondary)
        }

        HStack(spacing: 16) {
            stat("\(s.totalIdeas)", "ideas")
            if s.openLoops > 0 { stat("\(s.openLoops)", "open loops") }
            if s.decisions > 0 { stat("\(s.decisions)", "decisions") }
            if s.evolvedAcrossChats > 0 { stat("\(s.evolvedAcrossChats)", "across chats") }
        }
        .padding(.vertical, 4)

        if let f = s.featured {
            featuredIdea(f)
        }

        if capped {
            Divider()
            Text("You've hit the Free plan's 25-idea limit. Pro recovers the rest of your history.")
                .font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("Upgrade to Pro") { appState.openUpgradePage() }.buttonStyle(.borderedProminent)
                Button("Done") { appState.dismissBackfillOffer() }
            }
        } else {
            Button("Done") { appState.dismissBackfillOffer() }
                .padding(.top, 2)
        }
    }

    private func stat(_ n: String, _ label: String) -> some View {
        VStack(spacing: 1) {
            Text(n).font(.system(size: 18, weight: .semibold)).monospacedDigit()
            Text(label).font(.caption2).foregroundColor(.secondary)
        }
    }

    @ViewBuilder
    private func featuredIdea(_ f: AppState.BackfillSummary.Featured) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(f.title).font(.system(size: 13, weight: .semibold)).kerning(-0.1)
            Text("You first explored this \(Theme.ago(f.firstSeen)).")
                .font(.caption2).foregroundColor(.secondary)

            if let started = f.startedAs, started != f.nowThinks {
                Text("Started as").font(.caption2).foregroundStyle(Theme.ink(0.4))
                Text("“\(started)”").font(.system(size: 12)).foregroundStyle(Theme.ink(0.7))
                    .fixedSize(horizontal: false, vertical: true)
                Text("Now").font(.caption2).foregroundStyle(Theme.ink(0.4)).padding(.top, 2)
            }
            Text("“\(f.nowThinks)”").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink(0.85))
                .fixedSize(horizontal: false, vertical: true)

            if f.sources.count > 1 {
                Text(f.sources.joined(separator: " → "))
                    .font(.caption2).foregroundStyle(Theme.accent)
            }
            if let q = f.openQuestion {
                Text("Still open: \(q)")
                    .font(.caption2).italic().foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button("Continue thinking") {
                let id = f.ideaId
                appState.dismissBackfillOffer()
                Task { await appState.openIdea(id) }
            }
            .buttonStyle(.borderedProminent).controlSize(.small).padding(.top, 2)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
    }
}
