/**
 * Canonicalization: the step between a raw sensor observation and the canonical events the
 * Thinking Engine reasons over. See THREAD.md §7 / §17.
 *
 * Three epistemic levels, never blurred:
 *   raw evidence  -- what a sensor observed  (db/evidence.ts)
 *   canonical event -- the structurally-validated message           <- this file produces these
 *   thinking event -- what the engine inferred it means             (state/pipeline.ts)
 *
 * This is milestone 1: structure validation only. It records an integrity verdict and drops
 * messages that genuinely cannot be canonical events (no id, no text, unknown role, a duplicate
 * id within one observation). It does NOT yet gate anything as provisional vs committed, resolve
 * conversation identity, or reconcile against other observations -- those are later milestones.
 */

import type { CanonicalEvent, CaptureMethod, CaptureProvenance, Role } from "../types";

export interface ObservedMessage {
  id: string;
  role: Role;
  text: string;
  createdAt: string;
}

/** What one sensor reported for one conversation at one moment. */
export interface RawObservation {
  conversationId: string;
  source: CanonicalEvent["source"];
  /** Which sensor produced this observation. */
  sensor: CaptureMethod;
  /** The transcript as the sensor saw it -- full resend today, a delta once the protocol changes. */
  messages: ObservedMessage[];
  sourceUrl?: string | null;
  capture?: CaptureProvenance | null;
  /** When Thread received this observation. Defaults to now. */
  observedAt?: string;
}

export type IntegrityCode =
  | "empty_id" // a message with a blank id -- cannot be a canonical event, dropped
  | "empty_text" // a message with blank text -- dropped
  | "bad_role" // role is not user|assistant -- dropped
  | "duplicate_id" // the same id appeared earlier in this observation -- the later one dropped
  | "timestamp_regression" // createdAt goes backwards across the kept messages -- kept, flagged
  | "single_role" // more than one message and all the same role -- kept, flagged
  | "no_messages"; // nothing usable survived validation

export interface IntegrityIssue {
  code: IntegrityCode;
  detail: string;
}

/** A drop-causing code means the observation lost content; the advisory ones don't. */
const DROP_CODES: ReadonlySet<IntegrityCode> = new Set<IntegrityCode>([
  "empty_id",
  "empty_text",
  "bad_role",
  "duplicate_id",
  "no_messages",
]);

export interface CanonicalizeResult {
  /** Structurally valid messages as canonical events, re-indexed 0..n-1 by kept position. */
  events: CanonicalEvent[];
  integrity: {
    /** True when nothing was dropped -- advisory issues (regression, single_role) don't flip it. */
    ok: boolean;
    issues: IntegrityIssue[];
    /** Messages in the raw observation. */
    observed: number;
    /** Messages that became canonical events. */
    accepted: number;
  };
}

const isRole = (r: unknown): r is Role => r === "user" || r === "assistant";
const blank = (s: unknown): boolean => typeof s !== "string" || s.trim().length === 0;

/**
 * Validate a raw observation's structure and turn it into canonical events. For a clean
 * observation (the overwhelmingly common case) the output is identical to a plain positional
 * map -- same ids, same 0..n-1 indices -- so nothing downstream changes.
 */
export function canonicalize(obs: RawObservation): CanonicalizeResult {
  const issues: IntegrityIssue[] = [];
  const seenIds = new Set<string>();
  const kept: ObservedMessage[] = [];

  for (const m of obs.messages) {
    if (blank(m.id)) {
      issues.push({ code: "empty_id", detail: `message with role "${m.role}" has no id` });
      continue;
    }
    if (!isRole(m.role)) {
      issues.push({ code: "bad_role", detail: `message ${m.id} has role ${JSON.stringify(m.role)}` });
      continue;
    }
    if (blank(m.text)) {
      issues.push({ code: "empty_text", detail: `message ${m.id} has no text` });
      continue;
    }
    if (seenIds.has(m.id)) {
      issues.push({ code: "duplicate_id", detail: `id ${m.id} appeared more than once` });
      continue;
    }
    seenIds.add(m.id);
    kept.push(m);
  }

  if (obs.messages.length > 0 && kept.length === 0) {
    issues.push({ code: "no_messages", detail: "no message survived structure validation" });
  }

  // Advisory: timestamps that go backwards across the kept order. Pastes synthesize timestamps,
  // so this is a signal, not a failure.
  for (let i = 1; i < kept.length; i++) {
    if (kept[i]!.createdAt < kept[i - 1]!.createdAt) {
      issues.push({
        code: "timestamp_regression",
        detail: `message ${kept[i]!.id} is timestamped before the one before it`,
      });
      break;
    }
  }

  // Advisory: a multi-message observation that is entirely one role usually means the sensor
  // failed to distinguish turns.
  if (kept.length > 1 && kept.every((m) => m.role === kept[0]!.role)) {
    issues.push({ code: "single_role", detail: `all ${kept.length} messages are "${kept[0]!.role}"` });
  }

  const events: CanonicalEvent[] = kept.map((m, i) => ({
    id: m.id,
    conversationId: obs.conversationId,
    source: obs.source,
    role: m.role,
    text: m.text,
    createdAt: m.createdAt,
    index: i,
    sourceUrl: obs.sourceUrl ?? null,
    capture: obs.capture ?? null,
  }));

  return {
    events,
    integrity: {
      ok: !issues.some((x) => DROP_CODES.has(x.code)),
      issues,
      observed: obs.messages.length,
      accepted: events.length,
    },
  };
}
