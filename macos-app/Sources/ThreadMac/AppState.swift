import AppKit
import Foundation
import SwiftUI

@MainActor
final class AppState: ObservableObject {
    @Published var apiBaseUrl: String = CredentialStore.apiBaseUrl
    @Published var userId: String? = CredentialStore.userId

    @Published var searchQuery: String = ""
    @Published var searchResults: [SearchResult] = []
    @Published var thinkingState: ThinkingStateResponse?
    @Published var selectedIdeaId: String?
    @Published var selectedTrace: IdeaTrace?
    @Published var continueResult: String?
    @Published var errorMessage: String?
    @Published var isLoading = false
    @Published var pasteStatus: String?
    @Published var isPasting = false

    /// Last time a client (the browser extension / desktop agent) pulled credentials from the
    /// loopback pairing server. Drives the footer's "capturing" indicator.
    @Published var lastExtensionHandshake: Date?

    var client: APIClient {
        APIClient(baseURL: apiBaseUrl, credentials: CredentialStore.credentials)
    }

    var isPaired: Bool { CredentialStore.credentials != nil }

    enum CaptureStatus {
        case capturing, idle, unpaired
    }

    /// A client that handshook within the last 5 minutes is treated as actively connected.
    var captureStatus: CaptureStatus {
        guard isPaired else { return .unpaired }
        if let last = lastExtensionHandshake, Date().timeIntervalSince(last) < 300 { return .capturing }
        return .idle
    }

    func noteExtensionHandshake() {
        lastExtensionHandshake = Date()
    }

    /// The footer's privacy indicator. Only one mode exists today: conversations are extracted by
    /// the hosted backend. Local / zero-knowledge modes are a future capability, not a toggle to
    /// surface as if it worked.
    var privacyMode: String { "Cloud" }

    /// The one-line credential the browser extension needs when the automatic local handshake
    /// isn't available. Format matches the extension's `parsePairingString`.
    var pairingString: String? {
        guard let c = CredentialStore.credentials else { return nil }
        return "\(c.userId):\(c.token)"
    }

    /// JSON body the loopback PairingServer serves to the extension, or nil when not paired.
    nonisolated func pairingPayload() -> Data? {
        guard let c = CredentialStore.credentials else { return nil }
        let body: [String: String] = [
            "userId": c.userId,
            "token": c.token,
            "apiBaseUrl": CredentialStore.apiBaseUrl,
        ]
        return try? JSONSerialization.data(withJSONObject: body)
    }

    /// First-run bootstrap: make sure there's a *working* account so the app just works on launch
    /// and the pairing server never serves dead credentials to the extension. Safe every launch.
    func bootstrap() async {
        if let cred = CredentialStore.credentials {
            do {
                _ = try await APIClient(baseURL: apiBaseUrl, credentials: cred).getThinkingState()
                userId = cred.userId
                await refresh()
                return
            } catch let APIError.http(status, _) where status == 401 {
                CredentialStore.clear() // stale account -- fall through and re-pair
            } catch {
                // Backend unreachable: keep credentials, surface the problem, don't wipe.
                userId = cred.userId
                errorMessage = error.localizedDescription
                return
            }
        }
        await pairNewAccount()
    }

    func pairNewAccount() async {
        errorMessage = nil
        do {
            let created = try await APIClient.createUser(baseURL: apiBaseUrl)
            CredentialStore.save(userId: created.userId, token: created.token)
            userId = created.userId
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func unpair() {
        CredentialStore.clear()
        userId = nil
        thinkingState = nil
        searchResults = []
        closeIdea()
    }

    func useExistingCredentials(userId: String, token: String) {
        CredentialStore.save(userId: userId, token: token)
        self.userId = userId
        Task { await refresh() }
    }

    func setApiBaseUrl(_ url: String) {
        apiBaseUrl = url
        CredentialStore.apiBaseUrl = url
    }

    func refresh() async {
        guard isPaired else { return }
        isLoading = true
        errorMessage = nil
        do {
            thinkingState = try await client.getThinkingState()
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    func search() async {
        guard isPaired else { return }
        guard !searchQuery.trimmingCharacters(in: .whitespaces).isEmpty else {
            searchResults = []
            return
        }
        do {
            searchResults = try await client.searchIdeas(query: searchQuery)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func openIdea(_ id: String) async {
        selectedIdeaId = id
        errorMessage = nil
        do {
            selectedTrace = try await client.traceIdea(id: id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func closeIdea() {
        selectedIdeaId = nil
        selectedTrace = nil
        continueResult = nil
    }

    func renameSelected(to title: String) async {
        guard let id = selectedIdeaId else { return }
        do {
            _ = try await client.renameIdea(id: id, title: title)
            await openIdea(id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func setSelectedState(_ state: String) async {
        guard let id = selectedIdeaId else { return }
        do {
            _ = try await client.setIdeaState(id: id, state: state)
            await openIdea(id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func deleteSelected() async {
        guard let id = selectedIdeaId else { return }
        do {
            try await client.deleteIdea(id: id)
            closeIdea()
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func toggleLoop(_ loopId: String, resolved: Bool) async {
        do {
            try await client.setOpenLoopResolved(id: loopId, resolved: resolved)
            if let id = selectedIdeaId { await openIdea(id) } else { await refresh() }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// The native, browser-free way data gets into Thread: paste a conversation's text directly
    /// (copied from ChatGPT, Claude, anywhere) rather than relying on a browser extension to
    /// scrape a live page's DOM -- no selector fragility, no site-redesign breakage.
    func submitPaste(_ text: String) async -> Bool {
        guard isPaired else { return false }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        isPasting = true
        errorMessage = nil
        pasteStatus = nil
        do {
            let result = try await client.pasteConversation(text: trimmed)
            pasteStatus = "Captured \(result.newCognitiveEvents) idea\(result.newCognitiveEvents == 1 ? "" : "s")."
            await refresh()
            isPasting = false
            return true
        } catch {
            errorMessage = error.localizedDescription
            isPasting = false
            return false
        }
    }

    @Published var continueCopied = false
    /// Set briefly after "Send to X" so the view can show "Context ready — press ⌘V".
    @Published var sentToTool: AITool?

    enum AITool: String, CaseIterable, Identifiable {
        case claude, chatgpt, gemini, cursor
        var id: String { rawValue }
        var label: String {
            switch self {
            case .claude: return "Claude"
            case .chatgpt: return "ChatGPT"
            case .gemini: return "Gemini"
            case .cursor: return "Cursor"
            }
        }
        /// A "new chat" URL, or nil for tools with no web target (Cursor -> clipboard only).
        var newChatURL: URL? {
            switch self {
            case .claude: return URL(string: "https://claude.ai/new")
            case .chatgpt: return URL(string: "https://chatgpt.com/")
            case .gemini: return URL(string: "https://gemini.google.com/app")
            case .cursor: return nil
            }
        }
        static func from(source: String?) -> AITool? { source.flatMap { AITool(rawValue: $0) } }
    }

    private let preferredKey = "thread.preferredAI"

    /// The tool the user last developed this idea in, or an explicit preference, else Claude.
    var preferredTool: AITool {
        get {
            if let raw = UserDefaults.standard.string(forKey: preferredKey), let t = AITool(rawValue: raw) { return t }
            if let last = selectedTrace?.provenance.last?.source, let t = AITool.from(source: last) { return t }
            return .claude
        }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: preferredKey) }
    }

    /// A clean, paste-ready Markdown context block: current idea, evolution, open question,
    /// and (once fetched) the synthesised "where this stands".
    func contextMarkdown(for trace: IdeaTrace, synthesis: String?) -> String {
        var out = "### Current Idea: \(trace.idea.title)\n\n"
        out += "**Current formulation:**\n\(trace.idea.currentFormulation)\n\n"
        if !trace.provenance.isEmpty {
            out += "**Evolution:**\n"
            for step in trace.provenance { // chronological, oldest first
                let date = Theme.relative(step.createdAt)
                let src = step.sourceLabel.map { " _(\($0))_" } ?? ""
                out += "- \(date): \(step.formulation)\(src)\n"
            }
            out += "\n"
        }
        let loops = trace.idea.openLoops.filter { !$0.resolved }
        if !loops.isEmpty {
            out += "**Open question\(loops.count == 1 ? "" : "s"):**\n"
            for l in loops { out += "- \(l.statement)\n" }
            out += "\n"
        }
        if let synthesis, !synthesis.isEmpty {
            out += "**Where this stands:**\n\(synthesis)\n\n"
        }
        out += "---\nPlease continue from here."
        return out
    }

    private func copyContext(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        continueCopied = true
    }

    /// The payoff. Fetches the synthesis, copies the full context block, and (for a web tool)
    /// opens a fresh chat so the user just presses Cmd+V.
    func continueThinking(sendTo tool: AITool?) async {
        guard let trace = selectedTrace else { return }
        continueResult = "Thinking…"
        continueCopied = false
        sentToTool = nil

        var synthesis: String?
        do {
            synthesis = try await client.continueThinking(topic: trace.idea.title).text
            continueResult = synthesis
        } catch {
            continueResult = nil
            errorMessage = error.localizedDescription
        }

        copyContext(contextMarkdown(for: trace, synthesis: synthesis))

        if let tool {
            preferredTool = tool
            if let url = tool.newChatURL { NSWorkspace.shared.open(url) }
            sentToTool = tool
        }
    }
}
