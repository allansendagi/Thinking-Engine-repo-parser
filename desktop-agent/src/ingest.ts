import type { AgentConfig } from "./config";
import type { CapturedConversation } from "./sources/sourceAdapter";

export interface IngestResult {
  newCanonicalEvents: number;
  newCognitiveEvents: number;
  rejectedExtractions: number;
  ideaCount: number;
}

export async function sendConversation(
  config: AgentConfig,
  source: string,
  conversation: CapturedConversation,
): Promise<IngestResult> {
  const res = await fetch(`${config.apiBaseUrl}/v1/conversations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.userId}:${config.token}`,
    },
    body: JSON.stringify({
      conversationId: conversation.conversationId,
      source,
      messages: conversation.messages,
    }),
  });

  const body = (await res.json()) as IngestResult & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Ingest failed: ${res.status}`);
  return body;
}
