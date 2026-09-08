import { getSettings } from "./storage";
import type { CapturedMessage, Source } from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** True when an error means "your credentials are stale" -- the signal to drop them and re-pair. */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/** True when the account is valid but at the Free plan's idea cap -- capture is gated, not broken. */
export function isPaymentRequired(err: unknown): boolean {
  return err instanceof ApiError && err.status === 402;
}

/** Cheap authenticated round-trip used to confirm a set of credentials still works. */
export async function verifyCredentials(): Promise<void> {
  await request("/v1/thinking-state");
}

export interface AccountResponse {
  userId: string;
  email: string | null;
  plan: string;
  isPro: boolean;
  ideaCount: number;
}

/** Who this browser is capturing as -- id, email, plan. Shown in the popup so a user can tell
 *  they're pointed at the right account. */
export function getAccount(): Promise<AccountResponse> {
  return request("/v1/account");
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { apiBaseUrl, credentials } = await getSettings();
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (credentials) headers.set("authorization", `Bearer ${credentials.userId}:${credentials.token}`);

  const res = await fetch(`${apiBaseUrl}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new ApiError(res.status, body.error ?? `Request failed: ${res.status}`);
  return body;
}

export async function createUser(apiBaseUrl: string): Promise<{ userId: string; token: string }> {
  const res = await fetch(`${apiBaseUrl}/v1/users`, { method: "POST" });
  const body = (await res.json()) as { userId: string; token: string; error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? "Failed to create user");
  return body;
}

export interface IngestResult {
  newCanonicalEvents: number;
  newCognitiveEvents: number;
  rejectedExtractions: number;
  ideaCount: number;
}

export function ingestConversation(
  conversationId: string,
  source: Source,
  messages: CapturedMessage[],
  sourceUrl: string | null = null,
): Promise<IngestResult> {
  return request("/v1/conversations", {
    method: "POST",
    body: JSON.stringify({
      conversationId,
      source,
      messages,
      sourceUrl,
      // The extension reads the live DOM inside the page: exact roles and message boundaries.
      // See THREAD.md §7 (capture fidelity) and §17 (capture precedence).
      capture: { method: "browser_extension", fidelity: "high" },
    }),
  });
}

export function pasteConversation(text: string): Promise<IngestResult & { conversationId: string }> {
  return request("/v1/paste", { method: "POST", body: JSON.stringify({ text }) });
}

export interface IdeaSummary {
  id: string;
  title: string;
  state: string;
  currentFormulation: string;
}

export interface ThinkingState {
  topic: string | null;
  currentIdeas: IdeaSummary[];
  recentChanges: { ideaId: string; ideaTitle: string; formulation: string; createdAt: string }[];
  decisions: { ideaId: string; ideaTitle: string; statement: string; decidedAt: string }[];
  openLoops: { ideaId: string; ideaTitle: string; loopId: string; statement: string; resolved: boolean }[];
  contradictions: { ideaId: string; ideaTitle: string; formulation: string; createdAt: string }[];
  relatedIdeas: { id: string; title: string }[];
}

export function getThinkingState(topic?: string): Promise<ThinkingState> {
  const q = topic ? `?topic=${encodeURIComponent(topic)}` : "";
  return request(`/v1/thinking-state${q}`);
}

export function searchIdeas(q: string): Promise<(IdeaSummary & { score: number })[]> {
  return request(`/v1/ideas?q=${encodeURIComponent(q)}`);
}

export interface IdeaTrace {
  idea: IdeaSummary & {
    evolution: { formulation: string; createdAt: string }[];
    openLoops: { id: string; statement: string; resolved: boolean }[];
  };
  provenance: {
    formulation: string;
    createdAt: string;
    sourceText: string | null;
    sourceRole: string | null;
    source: string | null;
  }[];
}

export function traceIdea(id: string): Promise<IdeaTrace> {
  return request(`/v1/ideas/${id}/trace`);
}

export function renameIdea(id: string, title: string): Promise<IdeaSummary> {
  return request(`/v1/ideas/${id}`, { method: "PATCH", body: JSON.stringify({ title }) });
}

export function setIdeaState(id: string, state: string): Promise<IdeaSummary> {
  return request(`/v1/ideas/${id}`, { method: "PATCH", body: JSON.stringify({ state }) });
}

export function deleteIdea(id: string): Promise<void> {
  return request(`/v1/ideas/${id}`, { method: "DELETE" });
}

export function setOpenLoopResolved(id: string, resolved: boolean): Promise<void> {
  return request(`/v1/open-loops/${id}`, { method: "PATCH", body: JSON.stringify({ resolved }) });
}

export function continueThinking(topic: string): Promise<{ text: string }> {
  return request("/v1/continue", { method: "POST", body: JSON.stringify({ topic }) });
}

export interface ContinuePacketResponse {
  /** Paste-ready render. Carries `{{...}}` placeholders for the model-written slots -- see
   *  `resolveContinuationText`. */
  text: string;
  packet: { suggestedNext: string; thinkingShift?: string | null; trajectory?: string[] | null };
  tier?: "pro" | "free";
}

/**
 * The continuation packet for one idea -- the compact cognitive checkpoint (current formulation,
 * how the thinking changed, what's established, what's unresolved, the continuation task), NOT a
 * transcript. `/v1/continue` is not Pro-gated; `tier` just says whether the "continue from here"
 * line was model-written ("pro") or templated ("free").
 */
export function continueFromIdea(ideaId: string): Promise<ContinuePacketResponse> {
  return request("/v1/continue", { method: "POST", body: JSON.stringify({ ideaId }) });
}

const CONTINUE_TOKEN = "{{CONTINUE_FROM_HERE}}";
const THINKING_SHIFT_TOKEN = "{{THINKING_SHIFT}}";
const THINKING_EVOLUTION_TOKEN = "{{THINKING_EVOLUTION}}";

/**
 * Bake the model-written slots into the paste-ready text -- the browser twin of the server's
 * `resolvePacketText`. Replacing a token that isn't present is a no-op.
 */
export function resolveContinuationText(r: ContinuePacketResponse): string {
  const chain = (r.packet.trajectory ?? []).filter(Boolean).join("\n  ↓\n  ");
  return (
    r.text
      .replace(CONTINUE_TOKEN, r.packet.suggestedNext ?? "")
      .replace(THINKING_SHIFT_TOKEN, (r.packet.thinkingShift ?? "").trim())
      .replace(THINKING_EVOLUTION_TOKEN, chain)
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}
