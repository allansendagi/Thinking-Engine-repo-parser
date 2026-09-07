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

import type {
  CanonicalEvent,
  CanonicalEventStatus,
  CaptureMethod,
  CaptureProvenance,
  Role,
} from "../types";

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
  /**
   * Structurally valid messages as canonical events, re-indexed 0..n-1 by kept position, each
   * tagged `committed` or `provisional` per `provisionalReason` below.
   */
  events: CanonicalEvent[];
  integrity: {
    /** True when nothing was dropped -- advisory issues (regression, single_role) don't flip it. */
    ok: boolean;
    issues: IntegrityIssue[];
    /** Messages in the raw observation. */
    observed: number;
    /** Messages that became canonical events. */
    accepted: number;
    /** `committed` unless this observation is untrustworthy -- see `provisionalReason`. */
    status: CanonicalEventStatus;
    /** Why the events are provisional, or null when committed. */
    provisionalReason: string | null;
  };
}

/**
 * Policy: an observation's events are held provisional -- stored, used as context, but never
 * extracted into cognitive events until corroborated -- when the observation dropped content in
 * structure validation, or when the sensor itself rates the capture low fidelity. Identity being
 * unresolved is a third trigger, added in the identity milestone. Returns the reason, or null
 * when the observation is trustworthy enough to commit.
 */
export function provisionalReason(
  capture: CaptureProvenance | null | undefined,
  integrity: { ok: boolean; issues: IntegrityIssue[] },
): string | null {
  if (!integrity.ok) {
    const codes = [...new Set(integrity.issues.filter((i) => DROP_CODES.has(i.code)).map((i) => i.code))];
    return `structure validation dropped content: ${codes.join(", ")}`;
  }
  if (capture?.fidelity === "low") return "capture fidelity is low";
  return null;
}

const isRole = (r: unknown): r is Role => r === "user" || r === "assistant";
const blank = (s: unknown): boolean => typeof s !== "string" || s.trim().length === 0;

/**
 * Sensors that read real role labels -- an all-one-role transcript from one of these means the
 * sensor genuinely failed to distinguish turns. The desktop-agent scans undocumented on-disk
 * stores where role labels may be absent entirely (per its README), and OCR/paste never have
 * them, so `single_role` from those sensors is expected, not an anomaly -- don't flag it.
 */
const ROLE_AWARE_SENSORS: ReadonlySet<CaptureMethod> = new Set<CaptureMethod>([
  "browser_extension",
  "native_accessibility",
  "import",
]);

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

  // Advisory: a multi-message observation from a role-aware sensor that is entirely one role
  // usually means the sensor failed to distinguish turns. Skipped for sensors that don't carry
  // real role labels (desktop_agent, screen_ocr, paste) -- there it's expected, not a signal.
  if (
    ROLE_AWARE_SENSORS.has(obs.sensor) &&
    kept.length > 1 &&
    kept.every((m) => m.role === kept[0]!.role)
  ) {
    issues.push({ code: "single_role", detail: `all ${kept.length} messages are "${kept[0]!.role}"` });
  }

  const ok = !issues.some((x) => DROP_CODES.has(x.code));
  const reason = provisionalReason(obs.capture, { ok, issues });
  const status: CanonicalEventStatus = reason ? "provisional" : "committed";

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
    status,
  }));

  return {
    events,
    integrity: {
      ok,
      issues,
      observed: obs.messages.length,
      accepted: events.length,
      status,
      provisionalReason: reason,
    },
  };
}
