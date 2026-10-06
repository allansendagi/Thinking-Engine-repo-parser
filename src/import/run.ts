import type { Database } from "bun:sqlite";
import { parseChatGptExport } from "../parser/chatgpt";
import { parseClaudeExport } from "../parser/claude";
import { loadCanonicalEvents, loadIdeas } from "../db/queries";
import type { PipelineProviders } from "../state/pipeline";
import { extractOrDefer } from "../state/deferred";
import type { CanonicalEvent } from "../types";

export type ImportFormat = "chatgpt" | "claude";

export function parseExportFile(format: ImportFormat, raw: unknown): CanonicalEvent[] {
  const events = format === "chatgpt" ? parseChatGptExport(raw) : parseClaudeExport(raw);
  // An official export is complete and structurally exact -- high-fidelity capture (THREAD.md §7).
  return events.map((e) => ({
    ...e,
    capture: { method: "import" as const, fidelity: "high" as const },
  }));
}

export interface ImportSummary {
  newCanonicalEvents: number;
  /** Imported messages waiting for the AI (see state/deferred.ts). */
  extractionPending?: number;
  extractionError?: string | null;
  newCognitiveEvents: number;
  rejectedExtractions: number;
  ideaCount: number;
}

/**
 * Imports a full export file (potentially many conversations) into a user's DB, incrementally --
 * re-importing the same or an overlapping export (e.g. a newer download that includes previously
 * imported conversations) skips work already done, the same principle as the live-capture path
 * (api/ingest.ts). Only conversations containing at least one genuinely new message are re-run
 * through extraction at all -- no point paying for a model call on a conversation nothing changed
 * in.
 */
export async function importIntoDb(
  db: Database,
  events: CanonicalEvent[],
  providers: PipelineProviders,
): Promise<ImportSummary> {
  const existingCanonicalIds = new Set(loadCanonicalEvents(db).map((e) => e.id));
  const newEventIds = new Set(events.filter((e) => !existingCanonicalIds.has(e.id)).map((e) => e.id));

  if (newEventIds.size === 0) {
    return { newCanonicalEvents: 0, newCognitiveEvents: 0, rejectedExtractions: 0, ideaCount: loadIdeas(db).length };
  }

  const conversationsWithNewEvents = new Set(
    events.filter((e) => newEventIds.has(e.id)).map((e) => e.conversationId),
  );
  const relevantEvents = events.filter((e) => conversationsWithNewEvents.has(e.conversationId));

  // Stored first, then extracted -- or deferred with the reason if the AI is unavailable.
  const outcome = await extractOrDefer(db, relevantEvents, newEventIds, providers);
  if (!outcome.result) {
    return {
      newCanonicalEvents: newEventIds.size,
      newCognitiveEvents: 0,
      rejectedExtractions: 0,
      ideaCount: loadIdeas(db).length,
      extractionPending: outcome.deferred,
      extractionError: outcome.error,
    };
  }
  const result = outcome.result;

  return {
    newCanonicalEvents: newEventIds.size,
    newCognitiveEvents: result.cognitiveEvents.length,
    rejectedExtractions: result.rejectedExtractions.length,
    ideaCount: result.ideas.size,
  };
}
