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

    var client: APIClient {
        APIClient(baseURL: apiBaseUrl, credentials: CredentialStore.credentials)
    }

    var isPaired: Bool { CredentialStore.credentials != nil }

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
