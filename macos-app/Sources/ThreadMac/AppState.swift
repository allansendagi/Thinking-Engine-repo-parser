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

    var client: APIClient {
        APIClient(baseURL: apiBaseUrl, credentials: CredentialStore.credentials)
    }

    var isPaired: Bool { CredentialStore.credentials != nil }

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

    func continueThinkingOnSelected() async {
        guard let trace = selectedTrace else { return }
        continueResult = "Thinking…"
        do {
            let result = try await client.continueThinking(topic: trace.idea.title)
            continueResult = result.text
        } catch {
            continueResult = nil
            errorMessage = error.localizedDescription
        }
    }
}
