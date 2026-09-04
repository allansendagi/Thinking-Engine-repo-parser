import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../db/client";
import { loadIdeas } from "../db/queries";
import { planDedup, applyDedup } from "./dedup";

/**
 * Seed an idea directly -- canonical + cognitive + idea + evolution rows -- the way a
 * pre-backstop duplicate exists on disk. `planDedup` reads title + first evolution formulation;
 * `mergeIdeas` reads the evolution→cognitive join for state replay.
 */
function insertIdea(
  db: Database,
  o: {
    id: string;
    title: string;
    steps: {
      cog: string;
      type: string;
      formulation: string;
      createdAt: string;
    }[];
  },
): void {
  const first = o.steps[0] as { createdAt: string };
  const last = o.steps[o.steps.length - 1] as {
    formulation: string;
    createdAt: string;
  };
  // Store the state the pipeline would have derived from these steps -- that's how rows exist on
  // disk, and mergeIdeas treats a stored state that DIFFERS from the replay as a human override.
  let state = "developing";
  for (const s of o.steps) {
    if (s.type === "decision") state = "established";
    else if (s.type === "rejection") state = "rejected";
    else if (s.type === "contradiction") state = "contested";
    else if (s.type === "resolution" && state === "contested")
      state = "developing";
  }
  db.prepare(
    "INSERT INTO idea_nodes (id, title, state, current_formulation, why_it_matters, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)",
  ).run(
    o.id,
    o.title,
    state,
    last.formulation,
    first.createdAt,
    last.createdAt,
  );

  for (const s of o.steps) {
    const canon = `canon_${s.cog}`;
    db.prepare(
      "INSERT OR IGNORE INTO canonical_events (id, conversation_id, source, role, text, created_at, idx) VALUES (?, 'c', 'fixture', 'user', ?, ?, 0)",
    ).run(canon, s.formulation, s.createdAt);
    db.prepare(
      "INSERT OR IGNORE INTO cognitive_events (id, type, statement, confidence, persistence, source_event_id, evidence_quote) VALUES (?, ?, ?, 0.9, 'high', ?, 'q')",
    ).run(s.cog, s.type, s.formulation, canon);
    db.prepare(
      "INSERT INTO evolution_steps (idea_id, cognitive_event_id, formulation, created_at, source_event_id) VALUES (?, ?, ?, ?, ?)",
    ).run(o.id, s.cog, s.formulation, s.createdAt, canon);
  }
}

describe("state/dedup", () => {
  test("clusters pre-existing twins and collapses them, keeping the most-developed one", () => {
    const db = openDb(":memory:");
    insertIdea(db, {
      id: "idea_old_a",
      title: "Authority must be computable",
      steps: [
        {
          cog: "a1",
          type: "new_idea",
          formulation: "Authority must be computable.",
          createdAt: "2026-06-01T00:00:00.000Z",
        },
        {
          cog: "a2",
          type: "claim",
          formulation: "Authority must be verifiable by a program.",
          createdAt: "2026-06-10T00:00:00.000Z",
        },
        {
          cog: "a3",
          type: "decision",
          formulation: "We build authority as an executable resolver.",
          createdAt: "2026-06-20T00:00:00.000Z",
        },
      ],
    });
    insertIdea(db, {
      id: "idea_old_b",
      title: "Authority must be computable",
      steps: [
        {
          cog: "b1",
          type: "new_idea",
          formulation: "Authority must be computable.",
          createdAt: "2026-06-02T00:00:00.000Z",
        },
        {
          cog: "b2",
          type: "open_loop",
          formulation: "How is a computable authority audited?",
          createdAt: "2026-06-12T00:00:00.000Z",
        },
      ],
    });

    const clusters = planDedup(db);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.keepId).toBe("idea_old_a"); // 3 evolution steps vs 2
    expect(clusters[0]?.drop.map((d) => d.id)).toEqual(["idea_old_b"]);
    expect(clusters[0]?.drop[0]?.similarity).toBeGreaterThanOrEqual(0.9);

    const { merges } = applyDedup(db, clusters);
    expect(merges).toBe(1);

    const ideas = loadIdeas(db);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]?.id).toBe("idea_old_a");
    expect(ideas[0]?.evolution).toHaveLength(5);
    expect(ideas[0]?.state).toBe("established"); // a3 (decision) is the last state-changer in merged time order
    expect(ideas[0]?.currentFormulation).toBe(
      "We build authority as an executable resolver.",
    );
  });

  test("leaves genuinely distinct ideas alone even when one word overlaps", () => {
    const db = openDb(":memory:");
    insertIdea(db, {
      id: "idea_x",
      title: "Authority must be computable",
      steps: [
        {
          cog: "x1",
          type: "new_idea",
          formulation: "Authority must be computable.",
          createdAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    });
    insertIdea(db, {
      id: "idea_y",
      title: "Authority needs democratic legitimacy",
      steps: [
        {
          cog: "y1",
          type: "new_idea",
          formulation: "Authority without a mandate is just force.",
          createdAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    });

    expect(planDedup(db)).toHaveLength(0);
    expect(loadIdeas(db)).toHaveLength(2);
  });

  test("a lower threshold widens what counts as a twin", () => {
    const db = openDb(":memory:");
    insertIdea(db, {
      id: "idea_p",
      title: "Nudges must be rare",
      steps: [
        {
          cog: "p1",
          type: "new_idea",
          formulation: "A nudge that fires often is noise.",
          createdAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    });
    insertIdea(db, {
      id: "idea_q",
      title: "Nudges must be rare",
      steps: [
        {
          cog: "q1",
          type: "new_idea",
          formulation:
            "A nudge repeated often becomes background noise the user tunes out.",
          createdAt: "2026-06-02T00:00:00.000Z",
        },
      ],
    });

    expect(planDedup(db, 0.9)).toHaveLength(0); // first formulations differ enough
    expect(planDedup(db, 0.4)).toHaveLength(1); // same title + shared "nudge/fires/noise" clears a loose bar
  });
});
