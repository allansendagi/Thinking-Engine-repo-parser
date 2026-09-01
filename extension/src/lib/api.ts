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
): Promise<IngestResult> {
  return request("/v1/conversations", {
    method: "POST",
    body: JSON.stringify({ conversationId, source, messages }),
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
  provenance: { formulation: string; createdAt: string; sourceText: string | null; sourceRole: string | null }[];
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
