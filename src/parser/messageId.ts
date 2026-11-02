import { createHash } from "node:crypto";
import type { Role } from "../types";

/**
 * A message id derived from what the message says, for sources that give none (a paste, an export
 * row without its own id). Never a position: a positional id ("<conv>::3") names whatever happens
 * to sit third, so a later capture with a turn added or removed put different words under the same
 * id -- and every thought taken from the old words lost its source. Repeats of the same turn in
 * one conversation get "-2", "-3"... in order, so they stay distinct.
 */
export function contentMessageIds(conversationId: string): (role: Role, text: string) => string {
  const seen = new Map<string, number>();
  return (role, text) => {
    const base = `${conversationId}::${role[0]}${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };
}
