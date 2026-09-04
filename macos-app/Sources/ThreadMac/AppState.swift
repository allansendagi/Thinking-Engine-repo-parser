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
            pendingCaptures = snap.pendingCaptures
            pendingEdits = snap.pendingEdits
            localGraph = snap.localGraph
            embeddings = snap.embeddings
            lastSyncedAt = snap.savedAt == .distantPast ? nil : snap.savedAt
            if let server = snap.thinkingState {
                thinkingState = applyAll(pendingEdits, to: server)   // last synced graph + unsynced edits
            } else if !localGraph.ideas.isEmpty {
                thinkingState = applyAll(pendingEdits, to: localGraph.asThinkingState())
                thinkingStateIsLocal = true                          // never synced — show the on-device graph
            }
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
        // When we're showing the on-device graph, don't persist it as the "last synced" state —
        // it's kept separately in `localGraph` and rehydrated as the fallback.
        snapshot.thinkingState = thinkingStateIsLocal ? nil : thinkingState
        snapshot.pendingCaptures = pendingCaptures
        snapshot.pendingEdits = pendingEdits
        snapshot.localGraph = localGraph
        snapshot.embeddings = embeddings
        snapshot.savedAt = Date()
        LocalStore.save(snapshot, userId: CredentialStore.userId)
    }

    // MARK: - On-device semantic index (meaning-based recall + "Related")

    /// ideaId → cached vector for its current text. Kept fresh by `reconcileEmbeddings()`.
    @Published var embeddings: [String: EmbeddingEntry] = [:]
    private var isEmbedding = false

    /// Bring `embeddings` in line with the ideas currently on screen: embed anything new or
    /// changed, drop vectors for ideas that are gone. Cheap (a few hundred sync calls) but run
    /// off the main actor so a large first pass never janks the panel.
    func reconcileEmbeddings() {
        guard Embeddings.isAvailable, !isEmbedding else { return }
        let ideas: [(id: String, text: String)] = (thinkingState?.currentIdeas ?? []).map {
            ($0.id, Embeddings.text(title: $0.title, formulation: $0.currentFormulation))
        }
        guard !ideas.isEmpty else {
            if !embeddings.isEmpty { embeddings = [:]; persistSnapshot() }
            return
        }
        let current = embeddings
        let liveIds = Set(ideas.map(\.id))
        let stale = ideas.filter { current[$0.id]?.contentHash != stableHash($0.text) }
        let hasOrphans = current.keys.contains { !liveIds.contains($0) }
        guard !stale.isEmpty || hasOrphans else { return }

        isEmbedding = true
        Task.detached { [weak self] in
            var next = current.filter { liveIds.contains($0.key) }   // prune orphans
            for idea in stale {
                let h = stableHash(idea.text)
                if let v = Embeddings.vector(for: idea.text) {
                    next[idea.id] = EmbeddingEntry(contentHash: h, vector: v)
                }
            }
            await MainActor.run {
                guard let self else { return }
                self.embeddings = next
                self.isEmbedding = false
                self.persistSnapshot()
            }
        }
    }

    /// Idea ids most similar in meaning to `query`, best first. Empty when the model or index
    /// isn't ready.
    func semanticMatches(_ query: String, limit: Int = 8) -> [String] {
        guard Embeddings.isAvailable, !embeddings.isEmpty,
              let qv = Embeddings.vector(for: query) else { return [] }
        return topSimilar(
            to: qv,
            among: embeddings.map { (id: $0.key, vector: $0.value.vector) },
            floor: semanticSearchFloor, limit: limit
        ).map(\.id)
    }

    /// Up to `relatedIdeaLimit` ideas whose meaning is genuinely close to `ideaId` — for the
    /// "Related" list on an idea. Excludes itself and any already-linked ideas.
    func relatedIdeas(to ideaId: String) -> [IdeaSummary] {
        guard let selfVec = embeddings[ideaId]?.vector else { return [] }
        let ideas = thinkingState?.currentIdeas ?? []
        let alreadyLinked = Set(selectedTrace?.idea.id == ideaId ? selectedTrace?.idea.relatedIdeaIds ?? [] : [])
        let byId = Dictionary(uniqueKeysWithValues: ideas.map { ($0.id, $0) })
        return topSimilar(
            to: selfVec,
            among: embeddings.compactMap { byId[$0.key] != nil ? (id: $0.key, vector: $0.value.vector) : nil },
            floor: relatedIdeaFloor, limit: relatedIdeaLimit,
            exclude: alreadyLinked.union([ideaId])
        ).compactMap { byId[$0.id] }
    }

    // MARK: - On-device idea graph (the fallback when the backend hasn't provided state)

    /// The graph the on-device model builds from captures. Rendered only when `thinkingState`
    /// isn't coming from the server (offline, or never synced).
    @Published var localGraph = LocalGraph.empty
    /// True while `thinkingState` is a projection of `localGraph` rather than the server's graph.
    @Published private(set) var thinkingStateIsLocal = false

    /// Re-project the on-device graph into `thinkingState` (with unsynced edits overlaid). Called
    /// after a capture is absorbed while we're in local mode.
    private func showLocalGraph() {
        thinkingStateIsLocal = true
        thinkingState = applyAll(pendingEdits, to: localGraph.asThinkingState())
        if let id = selectedIdeaId, let t = localGraph.trace(id) {
            selectedTrace = applyAll(pendingEdits, to: t)
        }
    }

    // MARK: - Local-first capture

    /// Captures made on this Mac that the backend hasn't confirmed yet. Shown at the top of the
    /// panel with the on-device draft; cleared once the authoritative graph absorbs them.
    @Published var pendingCaptures: [PendingCapture] = []
    private var isFlushingCaptures = false

    /// Field edits made on this Mac that the backend hasn't confirmed yet. Overlaid on server
    /// state until each one syncs; see the "Local-first edits" section.
    @Published var pendingEdits: [PendingEdit] = []

    /// The local-first capture entry point. Writes the raw text locally and returns immediately;
    /// the on-device model drafts what it is, then it syncs in the background (and keeps retrying
    /// if the backend is down). Returns false only if there's no account or nothing to capture.
    @discardableResult
    func capture(_ rawText: String) -> Bool {
        guard isPaired else { return false }
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return false }

        let pc = PendingCapture(
            id: UUID().uuidString, text: text, draft: nil, createdAt: Date(), status: .extracting
        )
        pendingCaptures.insert(pc, at: 0)
        persistSnapshot()
        Task { await processCapture(pc.id) }
        return true
    }

    private func processCapture(_ id: String) async {
        let text = pendingCaptures.first(where: { $0.id == id })?.text ?? ""

        // One on-device pass does both jobs: draft the "Just captured" row, and — while the
        // backend isn't the source of truth (never synced, or offline) — fold the capture into
        // the local idea graph (extraction + identity) so the graph stays whole without it.
        let buildGraph = thinkingStateIsLocal || lastSyncedAt == nil
        let existing = localGraph.ideas.map { (id: $0.id, title: $0.title) }
        if let delta = await OnDeviceModel.absorbCapture(text: text, existing: buildGraph ? existing : []) {
            updatePending(id) { $0.draft = delta.draft }
            if buildGraph { localGraph = OnDeviceGraph.fold(delta, captureId: id, into: localGraph) }
        } else if let draft = await OnDeviceModel.extractIdea(from: text) {
            updatePending(id) { $0.draft = draft }
            if buildGraph {
                localGraph = OnDeviceGraph.fold(
                    OnDeviceModel.GraphDelta(target: "new", title: draft.title, formulation: draft.formulation,
                                             state: draft.state, openQuestion: draft.openQuestion),
                    captureId: id, into: localGraph
                )
            }
        }
        if buildGraph, thinkingStateIsLocal || thinkingState == nil { showLocalGraph() }
        persistSnapshot()
        reconcileEmbeddings()

        updatePending(id) { $0.status = .queued }
        await syncPending(id, thenRefresh: true)
    }

    @discardableResult
    private func syncPending(_ id: String, thenRefresh: Bool) async -> Bool {
        guard let pc = pendingCaptures.first(where: { $0.id == id }) else { return false }
        updatePending(id) { $0.status = .syncing }
        do {
            _ = try await client.pasteConversation(text: pc.text)
            pendingCaptures.removeAll { $0.id == id }
            persistSnapshot()
            if thenRefresh { await refresh() }   // pull the authoritative graph
            return true
        } catch {
            updatePending(id) { $0.status = .failed }   // stays visible; flushPending() retries
            return false
        }
    }

    /// Retry every capture the backend hasn't taken yet. Called after a successful refresh.
    private func flushPending() async {
        guard !isFlushingCaptures else { return }
        isFlushingCaptures = true
        defer { isFlushingCaptures = false }
        for pc in pendingCaptures where pc.status == .failed || pc.status == .queued {
            _ = await syncPending(pc.id, thenRefresh: false)
        }
    }

    private func updatePending(_ id: String, _ mutate: (inout PendingCapture) -> Void) {
        guard let i = pendingCaptures.firstIndex(where: { $0.id == id }) else { return }
        mutate(&pendingCaptures[i])
        persistSnapshot()
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

    /// How many times each idea's nudge has been shown, and the activity it was showing against.
    /// A later edit to the idea resets its count. Local-only, persisted. Drives nudge fatigue —
    /// shown three times without a resume and the idea stops being offered.
    private let resumeShownKey = "thread.resumeShown"
    @Published private var resumeShownRaw: [String: [String: Double]] =
        (UserDefaults.standard.dictionary(forKey: "thread.resumeShown") as? [String: [String: Double]]) ?? [:]

    private var resumeShown: [String: ResumeShown] {
        resumeShownRaw.compactMapValues { d in
            guard let c = d["count"], let s = d["since"] else { return nil }
            return ResumeShown(count: Int(c), sinceActivity: Date(timeIntervalSince1970: s))
        }
    }

    /// Called once each time the nudge actually appears for an idea. Resets the counter when the
    /// idea has moved since it was last shown.
    func noteResumeShown(_ ideaId: String, lastActivity: Date) {
        let prev = resumeShown[ideaId]
        let count = (prev != nil && lastActivity <= prev!.sinceActivity) ? prev!.count + 1 : 1
        resumeShownRaw[ideaId] = ["count": Double(count), "since": lastActivity.timeIntervalSince1970]
        UserDefaults.standard.set(resumeShownRaw, forKey: resumeShownKey)
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

        let unresolved = state.openLoops.filter { !$0.resolved }
        let openLoopIdeas = Set(unresolved.map(\.ideaId))
        let contradictionIdeas = Set(
            unresolved.filter { $0.statement.range(of: #"^\s*Unresolved contradiction:"#, options: .regularExpression) != nil }
                .map(\.ideaId)
        )
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
                isContradiction: contradictionIdeas.contains(idea.id) || idea.state == "contested",
                lastTouched: touched
            )
        }
        let snoozed = resumeSnoozed.mapValues { Date(timeIntervalSince1970: $0) }
        return pickResumeSuggestion(candidates, snoozed: snoozed, history: resumeShown)
    }

    /// Set by a Focus filter (`ThreadFocusFilterIntent`) — silences the ambient return
    /// *notification* while that Focus is on. The in-panel nudge is unaffected; opening the
    /// panel is deliberate.
    @Published var nudgesSilencedByFocus = false

    /// The last-activity timestamp for an idea, from Thinking State — for `noteResumeShown`.
    func lastActivity(of ideaId: String) -> Date {
        (thinkingState?.recentChanges ?? [])
            .filter { $0.ideaId == ideaId }
            .compactMap { Theme.parse($0.createdAt) }
            .max() ?? .distantPast
    }
    @Published var continueResult: String?
    @Published var errorMessage: String?
    @Published var isLoading = false

    /// Non-nil when this Mac had an account but the credential is gone or was rejected. The app
    /// shows `ReconnectView` (with the cached ideas still listed) instead of silently minting a
    /// new empty account. See `bootstrap()`.
    struct ReconnectInfo: Equatable {
        var knownEmail: String?
        var cachedIdeaCount: Int
        var cachedTitles: [String]
        /// True after a sign-in that landed on a *different* account than the one whose ideas
        /// are cached here -- we keep the cached snapshot and say so rather than overwrite it.
        var mismatch: Bool
    }
    @Published var reconnect: ReconnectInfo?
    var needsReconnect: Bool { reconnect != nil }

    /// Ideas currently reachable on this Mac -- used in the "you have no email, signing out
    /// strands these" confirmation.
    var reachableIdeaCount: Int { thinkingState?.currentIdeas.count ?? 0 }

    /// Signing out now would leave ideas unreachable: no verified email on the account means no
    /// way back to it. The UI confirms before `unpair()` in that case.
    var signOutWouldStrandIdeas: Bool {
        let email = account?.email ?? CredentialStore.credential?.email ?? CredentialStore.lastKnownEmail
        return email == nil && reachableIdeaCount > 0
    }

    /// Last time a client (the browser extension / desktop agent) pulled credentials from the
    /// loopback pairing server. Drives the footer's "capturing" indicator.
    @Published var lastExtensionHandshake: Date?

    /// Whether a browser has ever completed the loopback handshake on this account. Persisted,
    /// because the extension pulls credentials once and then works off its own copy -- so a live
    /// handshake this session is the exception, not the rule. Settings shows this as the
    /// connected / not-connected state; "Reconnect" is the escape hatch if it goes stale.
    private let browserPairedKey = "thread.browserPaired"
    @Published var browserEverPaired = UserDefaults.standard.bool(forKey: "thread.browserPaired")

    /// True only while a handshake is fresh (< 5 min) -- a genuine "talking right now" pulse.
    var browserActiveNow: Bool {
        guard let last = lastExtensionHandshake else { return false }
        return Date().timeIntervalSince(last) < 300
    }

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
        if !browserEverPaired {
            browserEverPaired = true
            UserDefaults.standard.set(true, forKey: browserPairedKey)
        }
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
        guard isPaired, reconnect == nil else { return }
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
            authError = Self.authErrorMessage(for: error, step: .sendCode)
            return false
        }
    }

    /// Signs this Mac in to the account for `email` (creates it if new). Replaces local credentials.
    /// When we're reconnecting to a known local graph, a sign-in that lands on a *different*
    /// account is surfaced as a mismatch -- the cached snapshot is left untouched.
    func signIn(email: String, code: String) async -> Bool {
        authBusy = true
        authError = nil
        defer { authBusy = false }
        do {
            let created = try await APIClient.authVerify(baseURL: apiBaseUrl, email: email, code: code)
            if let rc = reconnect, rc.cachedIdeaCount > 0, let prior = userId, created.userId != prior {
                reconnect = ReconnectInfo(
                    knownEmail: email,
                    cachedIdeaCount: rc.cachedIdeaCount,
                    cachedTitles: rc.cachedTitles,
                    mismatch: true
                )
                return false
            }
            CredentialStore.save(userId: created.userId, token: created.token, email: email)
            userId = created.userId
            reconnect = nil
            isOffline = false
            await refresh()
            await refreshAccount()
            await persistAccountEmailIfKnown()
            return true
        } catch {
            authError = Self.authErrorMessage(for: error, step: .verify)
            return false
        }
    }

    private enum AuthStep { case sendCode, verify }

    /// One honest message per failure mode, instead of collapsing 429 / offline / server error /
    /// bad code into "that code is wrong or expired".
    private static func authErrorMessage(for error: Error, step: AuthStep) -> String {
        switch error {
        case APIError.network:
            return "You're offline — can't reach Thread right now."
        case APIError.http(let status, _):
            switch status {
            case 429:
                return "Too many attempts. Wait a few minutes, then try again."
            case 400 where step == .verify:
                return "That code is wrong or expired."
            case 400:
                return "That doesn't look like a valid email address."
            case 502, 503:
                return step == .sendCode
                    ? "We couldn't send the email just now. Try again in a moment."
                    : "Thread is briefly unavailable. Try again in a moment."
            default:
                return "Something went wrong (\(status)). Try again."
            }
        default:
            return step == .sendCode
                ? "Couldn't send the code. Check the address and try again."
                : "Couldn't verify that code. Try again."
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

    /// Launch bootstrap. The one rule: a lost or rejected token is a **reconnect**, never a
    /// **restart**. The app only ever auto-creates an account on a genuine first run (no
    /// credential *and* no trace of a prior one). Every other failure keeps the cached graph on
    /// screen and routes to `ReconnectView`. Safe every launch.
    func bootstrap() async {
        switch CredentialStore.load() {
        case .ok(let cred):
            do {
                _ = try await APIClient(baseURL: apiBaseUrl, credentials: (cred.userId, cred.token))
                    .getThinkingState()
                userId = cred.userId
                reconnect = nil
                await refresh()
                await refreshAccount()
                await persistAccountEmailIfKnown()
            } catch let APIError.http(status, _) where status == 401 {
                // The token is dead; the account and its ideas are not. Don't wipe anything,
                // don't mint a new identity -- show the cached graph and offer one-tap reconnect.
                enterReconnect(knownEmail: cred.email ?? CredentialStore.lastKnownEmail)
            } catch {
                // Backend unreachable: keep credentials, keep the cached graph on screen (init
                // already hydrated it), just mark offline. The core loop still works.
                userId = cred.userId
                isOffline = true
            }

        case .unreadable:
            // A credential file is there but we can't read it right now -- classically, launched
            // at login before the Mac's first unlock. This is NEVER a new user; a relaunch after
            // unlock usually recovers on its own (the `.bak` fallback), and meanwhile reconnect
            // is one tap.
            enterReconnect(knownEmail: CredentialStore.lastKnownEmail)

        case .absent:
            let hadAnAccount = LocalStore.mostRecentSnapshot() != nil || CredentialStore.lastKnownEmail != nil
            if hadAnAccount && !CredentialStore.deliberatelySignedOut {
                // This Mac had an account; the credential is simply gone. Reconnect, don't start over.
                enterReconnect(knownEmail: CredentialStore.lastKnownEmail)
            } else {
                // Genuine first run, or a deliberate sign-out -- auto-create so capture works
                // with zero setup.
                await pairNewAccount()
            }
        }
    }

    /// Hydrate from the most recent snapshot on disk (whatever account it belonged to) and put
    /// the app into the reconnect state. Nothing is deleted; the ideas stay visible.
    private func enterReconnect(knownEmail: String?) {
        CredentialStore.clearDeliberateSignOut()
        if let (uid, snap) = LocalStore.mostRecentSnapshot() {
            userId = uid
            snapshot = snap
            pendingCaptures = snap.pendingCaptures
            pendingEdits = snap.pendingEdits
            localGraph = snap.localGraph
            embeddings = snap.embeddings
            lastSyncedAt = snap.savedAt == .distantPast ? nil : snap.savedAt
            if let server = snap.thinkingState {
                thinkingState = applyAll(pendingEdits, to: server)
                thinkingStateIsLocal = false
            } else if !localGraph.ideas.isEmpty {
                thinkingState = applyAll(pendingEdits, to: localGraph.asThinkingState())
                thinkingStateIsLocal = true
            }
        }
        let ideas = thinkingState?.currentIdeas ?? []
        reconnect = ReconnectInfo(
            knownEmail: knownEmail,
            cachedIdeaCount: ideas.count,
            cachedTitles: Array(ideas.prefix(4).map(\.title)),
            mismatch: false
        )
        isOffline = true
    }

    /// "Start fresh instead" on the reconnect screen. Wipes only the dead/unreadable credential
    /// and this account's in-memory state, then makes a new account. The old account's on-disk
    /// snapshot is deliberately **kept** -- signing back in to that account still brings it back.
    func startFresh() async {
        CredentialStore.clear()
        resetInMemoryState()
        await pairNewAccount()
    }

    /// Drop the pre-filled email on the reconnect screen so the user can type another.
    func useAnotherEmailForReconnect() {
        guard var r = reconnect else { return }
        r.knownEmail = nil
        reconnect = r
    }

    func pairNewAccount() async {
        errorMessage = nil
        reconnect = nil
        do {
            let created = try await APIClient.createUser(baseURL: apiBaseUrl)
            CredentialStore.save(userId: created.userId, token: created.token)
            userId = created.userId
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Fold the account's verified email into the stored credential (and the durable mirror) the
    /// first time we see it, so a future credential loss can offer one-tap reconnect without
    /// asking who this Mac belongs to.
    private func persistAccountEmailIfKnown() async {
        guard let email = account?.email,
              let c = CredentialStore.credential,
              c.email != email else {
            CredentialStore.rememberEmail(account?.email)
            return
        }
        CredentialStore.save(userId: c.userId, token: c.token, email: email)
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
        CredentialStore.clear()
        resetInMemoryState()
    }

    /// Clear everything the current account left in memory. Shared by `unpair()` (which also
    /// deletes the on-disk snapshot + revokes server-side) and `startFresh()` (which keeps the
    /// snapshot on disk so the old account stays recoverable). Without this, a stale
    /// `pendingCaptures` / `embeddings` from the old account would be persisted under the new
    /// account's userId on the next `persistSnapshot()`.
    private func resetInMemoryState() {
        snapshot = .empty
        pendingCaptures = []
        pendingEdits = []
        localGraph = .empty
        embeddings = [:]
        thinkingStateIsLocal = false
        lastSyncedAt = nil
        isOffline = false
        userId = nil
        thinkingState = nil
        searchResults = []
        reconnect = nil
        lastExtensionHandshake = nil
        browserEverPaired = false
        UserDefaults.standard.removeObject(forKey: browserPairedKey)
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

    func setApiBaseUrl(_ url: String) {
        let clean = CredentialStore.normalizeBaseURL(url)
        apiBaseUrl = clean
        CredentialStore.apiBaseUrl = clean
    }

    func refresh() async {
        guard isPaired, reconnect == nil else { return }
        isLoading = true
        do {
            let server = try await client.getThinkingState()
            // The server's graph is authoritative — it has the sharper extraction + real
            // identity resolution. Overlay edits made here that it hasn't taken yet so an
            // offline change isn't visually reverted.
            thinkingStateIsLocal = false
            thinkingState = pendingEdits.isEmpty ? server : applyAll(pendingEdits, to: server)
            isOffline = false
            lastSyncedAt = Date()
            errorMessage = nil
            persistSnapshot()
            await flushPending()
            await flushEdits()
        } catch {
            // Local-first: a failed sync is not an error the user has to see. Keep whatever's on
            // screen; fall back to the on-device graph if we have nothing else.
            isOffline = true
            if thinkingState == nil && !localGraph.ideas.isEmpty { showLocalGraph() }
        }
        isLoading = false
        reconcileEmbeddings()
        await refreshAccount()
    }

    func search() async {
        guard isPaired, reconnect == nil else { return }
        let q = searchQuery.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else {
            searchResults = []
            return
        }
        // Instant, offline, never fails: scan the local snapshot first. The panel shows results
        // on the same keystroke — no spinner, no round-trip. Keyword hits first (they're exact),
        // then meaning-based matches the words alone would miss.
        let ideas = thinkingState?.currentIdeas ?? []
        let keyword = localSearch(q, in: ideas)
        let seen = Set(keyword.map(\.id))
        let byId = Dictionary(uniqueKeysWithValues: ideas.map { ($0.id, $0) })
        let semantic: [SearchResult] = semanticMatches(q).compactMap { id in
            guard !seen.contains(id), let i = byId[id] else { return nil }
            return SearchResult(id: i.id, title: i.title, state: i.state,
                                currentFormulation: i.currentFormulation, score: 0)
        }
        searchResults = keyword + semantic

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

        // On-device graph: the trace comes straight from `localGraph`, no network.
        if thinkingStateIsLocal || id.hasPrefix("local_") {
            selectedTrace = localGraph.trace(id).map { applyAll(pendingEdits, to: $0) }
            return
        }

        // Cache-first: show the last-synced trace immediately (with unsynced edits overlaid),
        // then revalidate.
        let cached = snapshot.traces[id]
        if let cached { selectedTrace = applyAll(pendingEdits, to: cached) }

        do {
            let fresh = try await client.traceIdea(id: id)
            guard selectedIdeaId == id else { return }   // user moved on while it loaded
            snapshot.traces[id] = fresh
            selectedTrace = applyAll(pendingEdits, to: fresh)
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

    // MARK: - Local-first edits
    //
    // Every edit applies to the local read model at once and queues its call. Last-write-wins
    // per field — no merge. `refresh()` overlays the queue on top of the server's state until
    // each edit lands; a 4xx drops the edit (the idea's gone / the request was bad), a network
    // error keeps it for the next retry.

    private var isFlushingEdits = false

    /// Fold an edit into the local snapshot + the live @Published state, enqueue it, sync.
    private func enqueueEdit(_ edit: PendingEdit) {
        // A local-only idea (never synced) — edit the on-device graph directly; there's nothing
        // to queue for the backend.
        if edit.ideaId.hasPrefix("local_") {
            editLocalGraph(edit)
            if let s = thinkingState { thinkingState = apply(edit.kind, to: s, ideaId: edit.ideaId) }
            if let t = selectedTrace, t.idea.id == edit.ideaId { selectedTrace = applyAll([edit], to: t) }
            persistSnapshot()
            reconcileEmbeddings()
            return
        }
        pendingEdits = coalesced(pendingEdits, adding: edit)
        if let s = thinkingState { thinkingState = apply(edit.kind, to: s, ideaId: edit.ideaId) }
        if let t = selectedTrace, t.idea.id == edit.ideaId {
            selectedTrace = applyAll([edit], to: t)
        }
        persistSnapshot()
        reconcileEmbeddings()   // a rename / delete changes the semantic index
        Task { await flushEdits() }
    }

    private func editLocalGraph(_ edit: PendingEdit) {
        guard let i = localGraph.ideas.firstIndex(where: { $0.id == edit.ideaId }) else { return }
        switch edit.kind {
        case .rename(let title):
            localGraph.ideas[i].title = title
        case .setState(let s):
            localGraph.ideas[i].state = s
        case .resolveLoop(let loopId, let resolved):
            if let j = localGraph.ideas[i].openQuestions.firstIndex(where: { $0.id == loopId }) {
                localGraph.ideas[i].openQuestions[j].resolved = resolved
            }
        case .delete:
            localGraph.ideas.remove(at: i)
        }
    }

    func renameSelected(to title: String) async {
        guard let id = selectedIdeaId else { return }
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        enqueueEdit(.rename(id, t))
    }

    func setSelectedState(_ state: String) async {
        guard let id = selectedIdeaId else { return }
        enqueueEdit(.setState(id, state))
    }

    func deleteSelected() async {
        guard let id = selectedIdeaId else { return }
        snapshot.traces[id] = nil
        closeIdea()
        enqueueEdit(.delete(id))
    }

    func toggleLoop(_ loopId: String, resolved: Bool) async {
        let ideaId = selectedIdeaId
            ?? thinkingState?.openLoops.first { $0.loopId == loopId }?.ideaId
            ?? ""
        enqueueEdit(.resolveLoop(ideaId, loopId: loopId, resolved: resolved))
    }

    /// Send queued edits oldest-first. Stops on the first network error (retried next refresh);
    /// drops any edit the backend rejects with a 4xx.
    private func flushEdits() async {
        guard isPaired, !isFlushingEdits else { return }
        isFlushingEdits = true
        defer { isFlushingEdits = false }

        while let edit = pendingEdits.first {
            do {
                try await send(edit)
                pendingEdits.removeAll { $0.id == edit.id }
                persistSnapshot()
            } catch let APIError.http(status, _) where (400..<500).contains(status) && status != 429 {
                // Dead edit — idea deleted server-side, bad request. Drop it, keep going.
                pendingEdits.removeAll { $0.id == edit.id }
                persistSnapshot()
            } catch {
                // Network / 5xx — leave the queue intact and try again on the next refresh.
                if let i = pendingEdits.firstIndex(where: { $0.id == edit.id }) {
                    pendingEdits[i].attempts += 1
                }
                persistSnapshot()
                break
            }
        }
    }

    private func send(_ edit: PendingEdit) async throws {
        switch edit.kind {
        case .rename(let title):
            _ = try await client.renameIdea(id: edit.ideaId, title: title)
        case .setState(let state):
            _ = try await client.setIdeaState(id: edit.ideaId, state: state)
        case .resolveLoop(let loopId, let resolved):
            try await client.setOpenLoopResolved(id: loopId, resolved: resolved)
        case .delete:
            do { try await client.deleteIdea(id: edit.ideaId) }
            catch APIError.http(404, _) { /* already gone — done */ }
        }
    }

    /// The native, browser-free way data gets into Thread: paste a conversation's text directly
    /// (copied from ChatGPT, Claude, anywhere) rather than relying on a browser extension to
    /// scrape a live page's DOM -- no selector fragility, no site-redesign breakage.
    func submitPaste(_ text: String) async -> Bool {
        // Local-first: the capture lands instantly and syncs in the background. No spinner, no
        // failure toast — an offline capture just queues.
        capture(text)
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
    @discardableResult
    private func copyContext(_ text: String) -> Bool {
        guard !text.isEmpty else { return false }
        let pb = NSPasteboard.general
        pb.clearContents()
        var ok = pb.setString(text, forType: .string)
        if !ok {
            pb.declareTypes([.string], owner: nil)
            ok = pb.setString(text, forType: .string)
        }
        if ok { continueCopied = true }
        return ok
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
    /// A safe next-step line no matter what the model returned. Never a refusal / meta-comment.
    static let safeNextStep = "Continue developing this from exactly where it stands — don't restart."

    var continuationCopyText: String? {
        guard let text = continuationText, let packet = continuationPacket else { return nil }
        let edited = nextStepDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        var line = edited.isEmpty ? packet.suggestedNext : edited
        if OnDeviceModel.looksUnusable(line) { line = Self.safeNextStep }
        return text
            .replacingOccurrences(of: ContinuationPacket.continueToken, with: line)
            .replacingOccurrences(of: ContinuationPacket.thinkingShiftToken,
                                  with: (packet.thinkingShift ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
            .replacingOccurrences(of: ContinuationPacket.thinkingEvolutionToken, with: packet.trajectoryChain)
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
            nextStepDraft = OnDeviceModel.looksUnusable(r.packet.suggestedNext) ? Self.safeNextStep : r.packet.suggestedNext
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
                    // Swap in the on-device line only if the user hasn't edited the field.
                    if nextStepDraft == p.suggestedNext || nextStepDraft == Self.safeNextStep {
                        nextStepDraft = sharper
                    }
                    continuationEngine = .onDevice
                } else {
                    continuationEngine = .template
                }

                // Same treatment for the synthesized lines the server left as templates: sharpen
                // the "how your thinking changed" sentence and the distilled trajectory chain
                // on-device.
                if OnDeviceModel.status.isReady, p.evolution.count >= 2,
                   let first = p.evolution.first?.formulation,
                   let latest = p.evolution.last?.formulation {
                    if let shift = await OnDeviceModel.thinkingShift(from: first, to: latest) {
                        continuationPacket?.thinkingShift = shift
                    }
                    if let traj = await OnDeviceModel.trajectory(formulations: p.evolution.map { $0.formulation }) {
                        continuationPacket?.trajectory = traj
                    }
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
        // Prefer the rendered handoff; if it's somehow unavailable, fall back to the local
        // idea snapshot so ⌘V always pastes something useful.
        if let copy = continuationCopyText, copyContext(copy) { return }
        copyIdeaContext()
    }
}
