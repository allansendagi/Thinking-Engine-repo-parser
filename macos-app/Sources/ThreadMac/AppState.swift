import AppKit
import Foundation
import SwiftUI

/// The quick-recall panel's three segments. Lives here rather than in MenuBarListView's local
/// `@State` so an external surface (the `thread://` scheme, Services) can switch to it, and so
/// it survives the list⇄detail swap — same reasoning as `listSelection`.
enum ListTab: String, CaseIterable, Identifiable {
    case recent = "Recent", loops = "Open loops", all = "All"
    var id: String { rawValue }
}

@MainActor
final class AppState: ObservableObject {
    init() {
        Theme.accentOverride = accent.color   // seed from the persisted choice at launch

        // Local-first: hydrate the panel from the last synced snapshot before any network call,
        // so recall renders instantly and works offline. `refresh()` keeps the snapshot current.
        if let snap = LocalStore.load(userId: CredentialStore.userId) {
            snapshot = snap
            thinkingState = snap.thinkingState
            lastSyncedAt = snap.savedAt == .distantPast ? nil : snap.savedAt
        }
    }

    // MARK: - Local-first snapshot

    /// The on-disk read model. `thinkingState` + opened traces are mirrored here after every
    /// successful sync; see LocalStore.
    private var snapshot = LocalSnapshot.empty

    /// When the backend was last reached. Nil until the first successful sync on this Mac.
    @Published var lastSyncedAt: Date?
    /// True when the last sync attempt failed. A quiet "showing last synced" hint — never a
    /// blocking error; the cached graph stays fully usable.
    @Published var isOffline = false

    private func persistSnapshot() {
        snapshot.thinkingState = thinkingState
        snapshot.savedAt = Date()
        LocalStore.save(snapshot, userId: CredentialStore.userId)
    }

    // MARK: - Appearance preferences (Settings ▸ Appearance)

    @Published var accent: AccentChoice =
        AccentChoice(rawValue: UserDefaults.standard.string(forKey: "thread.accent") ?? "") ?? .blue
    {
        didSet {
            UserDefaults.standard.set(accent.rawValue, forKey: "thread.accent")
            Theme.accentOverride = accent.color
        }
    }
    @Published var density: Density =
        Density(rawValue: UserDefaults.standard.string(forKey: "thread.density") ?? "") ?? .regular
    {
        didSet { UserDefaults.standard.set(density.rawValue, forKey: "thread.density") }
    }
    @Published var showSnippets: Bool =
        UserDefaults.standard.object(forKey: "thread.showSnippets") as? Bool ?? true
    {
        didSet { UserDefaults.standard.set(showSnippets, forKey: "thread.showSnippets") }
    }

    @Published var apiBaseUrl: String = CredentialStore.apiBaseUrl
    @Published var userId: String? = CredentialStore.userId

    @Published var searchQuery: String = ""
    @Published var searchResults: [SearchResult] = []
    @Published var thinkingState: ThinkingStateResponse?
    @Published var selectedIdeaId: String?
    @Published var selectedTrace: IdeaTrace?

    /// Which list row is highlighted blue. Lives here (not in MenuBarListView's local @State) so
    /// it survives the list⇄detail swap — click a row, open it, come back, and it's still the
    /// selected one, exactly like the design mock's persistent `state.sel`.
    @Published var listSelection: String?

    /// Which of the panel's three segments is showing. See `ListTab`.
    @Published var listTab: ListTab = .recent

    /// Idea ids the user has pinned. Shown as a "Pinned" group at the top of the All tab.
    /// Local-only (no backend concept), persisted across launches.
    private let pinnedKey = "thread.pinnedIds"
    @Published private(set) var pinnedIds: Set<String> =
        Set(UserDefaults.standard.stringArray(forKey: "thread.pinnedIds") ?? [])

    func isPinned(_ id: String) -> Bool { pinnedIds.contains(id) }

    func togglePin(_ id: String) {
        if pinnedIds.contains(id) { pinnedIds.remove(id) } else { pinnedIds.insert(id) }
        UserDefaults.standard.set(Array(pinnedIds), forKey: pinnedKey)
    }

    // MARK: - Resume suggestion (the one restrained "you may be returning to…" nudge)

    /// Snooze timestamps per idea. "Not now" and "Resume" both record now; the nudge only
    /// resurfaces for an idea once it has been touched *since* you dismissed it -- new activity
    /// is new evidence. Local-only, persisted.
    private let resumeSnoozeKey = "thread.resumeSnoozed"
    @Published private var resumeSnoozed: [String: Double] =
        (UserDefaults.standard.dictionary(forKey: "thread.resumeSnoozed") as? [String: Double]) ?? [:]

    func snoozeResume(_ ideaId: String) {
        resumeSnoozed[ideaId] = Date().timeIntervalSince1970
        UserDefaults.standard.set(resumeSnoozed, forKey: resumeSnoozeKey)
    }

    /// The single highest-confidence idea worth resuming, or nil. Deliberately conservative:
    ///   • has an unresolved open loop OR is contested (there is genuinely something unfinished)
    ///   • not dormant / rejected
    ///   • last touched between 3 and 45 days ago -- long enough that you were interrupted,
    ///     recent enough that it isn't abandoned
    ///   • not snoozed (unless it's been worked on since)
    /// Only the most-recently-touched qualifier is returned; if nothing qualifies, no nudge.
    var resumeSuggestion: ResumeSuggestion? {
        guard isPaired, let state = thinkingState else { return nil }

        let openLoopIdeas = Set(state.openLoops.filter { !$0.resolved }.map(\.ideaId))
        var lastTouched: [String: Date] = [:]
        for c in state.recentChanges {
            guard let d = Theme.parse(c.createdAt) else { continue }
            if lastTouched[c.ideaId].map({ d > $0 }) ?? true { lastTouched[c.ideaId] = d }
        }

        let candidates = state.currentIdeas.compactMap { idea -> ResumeCandidate? in
            guard let touched = lastTouched[idea.id] else { return nil }
            return ResumeCandidate(
                id: idea.id,
                title: cleanIdeaTitle(idea.title, fallback: idea.currentFormulation),
                state: idea.state,
                source: idea.sourceLabel,
                hasOpenLoop: openLoopIdeas.contains(idea.id),
                lastTouched: touched
            )
        }
        let snoozed = resumeSnoozed.mapValues { Date(timeIntervalSince1970: $0) }
        return pickResumeSuggestion(candidates, snoozed: snoozed)
    }
    @Published var continueResult: String?
    @Published var errorMessage: String?
    @Published var isLoading = false
    @Published var pasteStatus: String?
    @Published var isPasting = false

    /// Last time a client (the browser extension / desktop agent) pulled credentials from the
    /// loopback pairing server. Drives the footer's "capturing" indicator.
    @Published var lastExtensionHandshake: Date?

    /// Trial / subscription state. nil until first fetched.
    @Published var account: AccountStatus?
    @Published var billingBusy = false

    private let onboardingKey = "thread.onboardingDismissed"
    @Published var onboardingDismissed = UserDefaults.standard.bool(forKey: "thread.onboardingDismissed")

    func dismissOnboarding() {
        onboardingDismissed = true
        UserDefaults.standard.set(true, forKey: onboardingKey)
    }

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

    /// Footer's third slot: "Free · N/25" / "Pro" once billing is live, else "Cloud".
    var planLabel: String { account?.footerLabel ?? "Cloud" }

    /// True when billing is on AND this account can no longer capture. Reads still work.
    var isLocked: Bool { (account?.billingEnabled ?? false) && !(account?.canCapture ?? true) }

    /// The paywall banner is a nudge, not a wall -- the user can dismiss it for the session.
    /// Resets on relaunch (and whenever the lock clears), so it comes back if they stay capped.
    @Published var paywallBannerDismissed = false
    func dismissPaywallBanner() { paywallBannerDismissed = true }
    var showsPaywallBanner: Bool { isPaired && isLocked && !paywallBannerDismissed }

    /// Where the founder buys Pro / manages the account -- payment lives on the website.
    static let marketingBaseURL = "https://www.threadnow.app"

    /// The Chrome Web Store listing, once the extension is published. Until then the pairing
    /// screen points at the get-started page instead -- no dead link either way.
    static let chromeWebStoreURL: String? = nil
    static var browserExtensionURL: URL? {
        URL(string: chromeWebStoreURL ?? "\(marketingBaseURL)/get-started")
    }

    @Published var authBusy = false
    @Published var authError: String?

    func refreshAccount() async {
        guard isPaired else { return }
        account = try? await client.getAccount()
    }

    /// Payment happens on the website. This just opens the account page in the browser.
    func openUpgradePage() {
        if let u = URL(string: "\(Self.marketingBaseURL)/account") { NSWorkspace.shared.open(u) }
    }

    func openBillingPortal() async {
        billingBusy = true
        defer { billingBusy = false }
        do {
            NSWorkspace.shared.open(try await client.billingPortalURL())
        } catch {
            openUpgradePage() // no Paddle customer yet -> send them to the site to subscribe
        }
    }

    // MARK: - Email sign-in / claim

    /// Sends a 6-digit code for signing in on this Mac with an existing account's email.
    func sendSignInCode(email: String) async -> Bool {
        authBusy = true
        authError = nil
        defer { authBusy = false }
        do {
            try await APIClient.authStart(baseURL: apiBaseUrl, email: email)
            return true
        } catch {
            authError = "Couldn't send the code. Check the address."
            return false
        }
    }

    /// Signs this Mac in to the account for `email` (creates it if new). Replaces local credentials.
    func signIn(email: String, code: String) async -> Bool {
        authBusy = true
        authError = nil
        defer { authBusy = false }
        do {
            let created = try await APIClient.authVerify(baseURL: apiBaseUrl, email: email, code: code)
            useExistingCredentials(userId: created.userId, token: created.token)
            await refreshAccount()
            return true
        } catch {
            authError = "That code is wrong or expired."
            return false
        }
    }

    /// Attaches an email to *this* (already paired) account, keeping all its ideas.
    func sendClaimCode(email: String) async -> Bool {
        authBusy = true
        authError = nil
        defer { authBusy = false }
        do {
            try await client.accountEmailStart(email: email)
            return true
        } catch {
            authError = "Couldn't send the code."
            return false
        }
    }

    func claimEmail(email: String, code: String) async -> Bool {
        authBusy = true
        authError = nil
        defer { authBusy = false }
        do {
            account = try await client.accountEmailVerify(email: email, code: code)
            return true
        } catch let APIError.http(status, _) where status == 409 {
            authError = "That email is already on another account. Sign in with it instead."
            return false
        } catch {
            authError = "That code is wrong or expired."
            return false
        }
    }

    /// The one-line credential the browser extension needs when the automatic local handshake
    /// isn't available. Format matches the extension's `parsePairingString`.
    var pairingString: String? {
        guard let c = CredentialStore.credentials else { return nil }
        return "\(c.userId):\(c.token)"
    }

    // MARK: - Pairing window
    //
    // The loopback server only hands the bearer token to the extension during a short, explicit
    // window -- opened for ~2 min on launch, or when the user clicks "Connect a browser" in
    // Settings. Outside it the endpoint 404s, so a local process that isn't listening at exactly
    // the right moment can't siphon the token. The extension keeps working on its saved
    // credentials; it only needs a fresh window if those are ever rejected.
    //
    // Read from the pairing server's own queue, so it's lock-guarded rather than @MainActor.

    private let pairingWindowLock = NSLock()
    nonisolated(unsafe) private var pairingWindowUntil: Date?

    nonisolated var isPairingWindowOpen: Bool {
        pairingWindowLock.lock(); defer { pairingWindowLock.unlock() }
        return (pairingWindowUntil.map { $0 > Date() }) ?? false
    }

    nonisolated func openPairingWindow(seconds: TimeInterval = 180) {
        pairingWindowLock.lock()
        pairingWindowUntil = Date().addingTimeInterval(seconds)
        pairingWindowLock.unlock()
        Task { @MainActor in self.objectWillChange.send() }
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds + 0.5) { [weak self] in
            Task { @MainActor in self?.objectWillChange.send() }
        }
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
                await refreshAccount()
                return
            } catch let APIError.http(status, _) where status == 401 {
                CredentialStore.clear() // stale account -- fall through and re-pair
            } catch {
                // Backend unreachable: keep credentials, keep the cached graph on screen (init
                // already hydrated it), just mark offline. The core loop still works.
                userId = cred.userId
                isOffline = true
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
        // Revoke this device's token server-side (best-effort) before dropping the local copy, so
        // "Sign out" actually ends the session everywhere -- not just on this Mac.
        if let cred = CredentialStore.credentials {
            let base = apiBaseUrl
            Task.detached {
                try? await APIClient(baseURL: base, credentials: cred).signOutThisDevice()
            }
        }
        LocalStore.clear(userId: CredentialStore.userId)
        snapshot = .empty
        lastSyncedAt = nil
        isOffline = false
        CredentialStore.clear()
        userId = nil
        thinkingState = nil
        searchResults = []
        closeIdea()
    }

    /// Sign out every other device on this account (keeps this Mac signed in).
    func signOutOtherDevices() async {
        guard isPaired else { return }
        do {
            let n = try await client.signOutOtherDevices()
            errorMessage = n > 0 ? "Signed out \(n) other device\(n == 1 ? "" : "s")." : "No other devices were signed in."
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
        let clean = CredentialStore.normalizeBaseURL(url)
        apiBaseUrl = clean
        CredentialStore.apiBaseUrl = clean
    }

    func refresh() async {
        guard isPaired else { return }
        isLoading = true
        do {
            thinkingState = try await client.getThinkingState()
            isOffline = false
            lastSyncedAt = Date()
            errorMessage = nil
            persistSnapshot()
        } catch {
            // Local-first: a failed sync is not an error the user has to see. Keep the cached
            // graph on screen; just note we're offline so the UI can show a quiet hint.
            isOffline = true
        }
        isLoading = false
        await refreshAccount()
    }

    func search() async {
        guard isPaired else { return }
        let q = searchQuery.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else {
            searchResults = []
            return
        }
        // Instant, offline, never fails: scan the local snapshot first. The panel shows results
        // on the same keystroke — no spinner, no round-trip.
        searchResults = localSearch(q, in: thinkingState?.currentIdeas ?? [])

        // Then reconcile with the server when it's reachable (better ranking, ideas not yet in
        // the snapshot). If it's down or the query moved on, the local results stand.
        do {
            let remote = try await client.searchIdeas(query: q)
            if q == searchQuery.trimmingCharacters(in: .whitespaces) { searchResults = remote }
        } catch {
            // keep the local results; offline is surfaced by refresh(), not here
        }
    }

    /// Route a `ThreadAction` from an outside surface (the `thread://` scheme, the Services menu,
    /// App Intents). Always brings the quick-recall panel up; for `.recall` it seeds the very
    /// same search field the user would type into, so there's one code path for "show me ideas
    /// matching X".
    func perform(_ action: ThreadAction) {
        func present() { NotificationCenter.default.post(name: .threadPresentPanel, object: nil) }

        guard isPaired else { present(); return }

        switch action {
        case .recall(let text):
            closeIdea()
            listTab = .recent
            searchQuery = text
            present()
            Task { await search() }
        case .openIdea(let id):
            present()
            Task { await openIdea(id) }
        case .openLoops:
            closeIdea()
            searchQuery = ""
            listTab = .loops
            present()
            Task { await refresh() }
        case .continueIdea(let id):
            present()
            Task {
                await openIdea(id)
                await continueThinking(sendTo: nil)
            }
        case .continueTopic(let topic):
            present()
            Task {
                let hit = (try? await client.searchIdeas(query: topic))?.first
                if let hit {
                    await openIdea(hit.id)
                    await continueThinking(sendTo: nil)
                } else {
                    // Nothing matched -- fall back to the search so the user can pick.
                    closeIdea()
                    listTab = .recent
                    searchQuery = topic
                    await search()
                }
            }
        }
    }

    func openIdea(_ id: String) async {
        // Switching to a different idea: drop any continuation preview/draft from the previous
        // one so it can't linger under the new idea's detail (panel and full window share this
        // AppState, and the full window changes ideas by selecting a row, not via closeIdea()).
        if id != selectedIdeaId {
            continueResult = nil
            continuationPacket = nil
            continuationText = nil
            nextStepDraft = ""
            continueCopied = false
            sentToTool = nil
        }
        selectedIdeaId = id
        errorMessage = nil

        // Cache-first: show the last-synced trace immediately, then revalidate.
        let cached = snapshot.traces[id]
        if let cached { selectedTrace = cached }

        do {
            let fresh = try await client.traceIdea(id: id)
            guard selectedIdeaId == id else { return }   // user moved on while it loaded
            selectedTrace = fresh
            snapshot.traces[id] = fresh
            persistSnapshot()
        } catch {
            // Only an error if we had nothing cached to show.
            if cached == nil { errorMessage = error.localizedDescription }
        }
    }

    func closeIdea() {
        selectedIdeaId = nil
        selectedTrace = nil
        continueResult = nil
        continuationPacket = nil
        continuationText = nil
        nextStepDraft = ""
        continueCopied = false
        sentToTool = nil
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
    private func copyContext(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        continueCopied = true
    }

    /// Free, local, no server call: a Markdown snapshot of the selected idea — its current
    /// formulation, how it developed, and what's still open — on the clipboard to paste
    /// anywhere. The Pro "Continue this idea" path (/v1/continue) is what adds the AI-written
    /// next step and the one-click handoff into a fresh chat.
    func copyIdeaContext() {
        guard let trace = selectedTrace else { return }
        let idea = trace.idea
        var out = "# \(idea.title)\n\n"
        out += "**Where this stands:** \(idea.currentFormulation)\n"
        out += "_State: \(idea.state.capitalized)_\n"

        if !trace.provenance.isEmpty {
            out += "\n## How it developed\n"
            for (i, s) in trace.provenance.enumerated() {
                let src = s.sourceLabel.map { " · \($0)" } ?? ""
                out += "\(i + 1). \(Self.shortDay(s.createdAt))\(src) — \(s.formulation)\n"
            }
        }

        let open = idea.openLoops.filter { !$0.resolved }
        if !open.isEmpty {
            out += "\n## Open questions\n"
            for l in open { out += "- \(l.statement)\n" }
        }

        if !idea.decisions.isEmpty {
            out += "\n## Decisions\n"
            for d in idea.decisions { out += "- \(d.statement)\n" }
        }

        out += "\n---\nCaptured with Thread · first seen \(Self.shortDay(idea.createdAt)), "
        out += "last touched \(Self.shortDay(idea.updatedAt))\n"

        copyContext(out)
    }

    private static func shortDay(_ iso: String) -> String {
        let parsers: [ISO8601DateFormatter] = [
            ISO8601DateFormatter(),
            { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }(),
        ]
        for p in parsers where p.date(from: iso) != nil {
            let out = DateFormatter(); out.dateFormat = "d MMM yyyy"
            return out.string(from: p.date(from: iso)!)
        }
        return String(iso.prefix(10))
    }

    /// The last continuation packet fetched, for the in-app preview (source affordances +
    /// editable next step). `continuationText` is the server's verbatim paste-ready render.
    @Published var continuationPacket: ContinuationPacket?
    @Published var continuationText: String?
    /// The user's edit of "Continue from here". Empty = use packet.suggestedNext untouched.
    @Published var nextStepDraft: String = ""
    /// Which engine wrote the "Continue from here" line in the current handoff.
    @Published var continuationEngine: ContinuationEngine = .none

    /// The paste string. The backend leaves a token where the "Continue from here" line goes;
    /// we fill it with the user's edit or the suggested default in one literal replace. No
    /// client-side re-render, no fuzzy anchor matching -- the token can't collide or drift.
    var continuationCopyText: String? {
        guard let text = continuationText, let packet = continuationPacket else { return nil }
        let edited = nextStepDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let line = edited.isEmpty ? packet.suggestedNext : edited
        return text.replacingOccurrences(of: ContinuationPacket.continueToken, with: line)
    }

    /// The payoff. Builds the continuation packet for the selected idea, copies the paste-ready
    /// text, and (for a web tool) opens a fresh chat so the user just presses Cmd+V. The preview
    /// card then shows exactly what was sent.
    func continueThinking(sendTo tool: AITool?) async {
        guard let trace = selectedTrace else { return }
        continueResult = "Thinking…"
        continueCopied = false
        sentToTool = nil
        continuationPacket = nil
        continuationText = nil
        continuationEngine = .none

        do {
            let r = try await client.continueIdea(ideaId: trace.idea.id)
            continuationPacket = r.packet
            continuationText = r.text
            nextStepDraft = r.packet.suggestedNext
            continueResult = r.text

            if r.tier == "pro" {
                // The server wrote "Continue from here" with a frontier model.
                continuationEngine = .frontier
            } else if r.tier == "free" {
                // Free tier: the server left the deterministic template on "Continue from here".
                // Sharpen that one line on this Mac (Apple Foundation Models) — no server call,
                // no cost. If the on-device model isn't available, the template stands.
                let p = r.packet
                if OnDeviceModel.status.isReady,
                   let sharper = await OnDeviceModel.continueFromHere(
                       whereYouLeftOff: p.whereYouLeftOff,
                       evolution: p.evolution.map { $0.formulation },
                       unresolvedQuestion: p.unresolvedQuestion,
                       contested: p.contested
                   ),
                   !sharper.isEmpty {
                    // Only overwrite if the user hasn't already edited the field.
                    if nextStepDraft == p.suggestedNext { nextStepDraft = sharper }
                    continuationEngine = .onDevice
                } else {
                    continuationEngine = .template
                }
            }
        } catch {
            continueResult = nil
            errorMessage = error.localizedDescription
            return
        }

        if let copy = continuationCopyText { copyContext(copy) }

        if let tool {
            preferredTool = tool
            if let url = tool.newChatURL { NSWorkspace.shared.open(url) }
            sentToTool = tool
        }
    }

    /// Re-copy after the user tweaks "Continue from here" in the preview.
    func recopyContinuation() {
        if let copy = continuationCopyText { copyContext(copy) }
    }
}
