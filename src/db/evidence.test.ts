import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { openDb } from "./client";
import { captureHealthSummary } from "./evidence";

/** Insert one evidence row directly -- this suite tests the health aggregation, not recordEvidence. */
function seed(
  db: ReturnType<typeof openDb>,
  o: { sensor: string; observedAt: string; ok: boolean; issues?: { code: string; detail: string }[] },
) {
  db.prepare(
    `INSERT INTO evidence
       (id, conversation_id, sensor, observed_at, observed_count, accepted_count,
        integrity_ok, integrity_issues, payload)
     VALUES (?, 'c', ?, ?, 2, ?, ?, ?, '{}')`,
  ).run(
    randomUUID(),
    o.sensor,
    o.observedAt,
    o.ok ? 2 : 1,
    o.ok ? 1 : 0,
    o.issues && o.issues.length ? JSON.stringify(o.issues) : null,
  );
}

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

describe("captureHealthSummary (THREAD.md §17 -- make a broken sensor visible)", () => {
  test("all-clean observations -> healthy, no degraded sensor", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 5; i++) seed(db, { sensor: "browser_extension", observedAt: iso(i), ok: true });
    const h = captureHealthSummary(db);
    expect(h.healthy).toBe(true);
    expect(h.sensors).toHaveLength(1);
    expect(h.sensors[0]).toMatchObject({ sensor: "browser_extension", observations: 5, failed: 0, degraded: false });
  });

  test("a sensor failing >half its observations is degraded, and the summary is unhealthy", () => {
    const db = openDb(":memory:");
    seed(db, { sensor: "browser_extension", observedAt: iso(3), ok: true });
    seed(db, { sensor: "browser_extension", observedAt: iso(2), ok: false, issues: [{ code: "bad_role", detail: "role 'system'" }] });
    seed(db, { sensor: "browser_extension", observedAt: iso(1), ok: false, issues: [{ code: "bad_role", detail: "role 'system'" }] });
    seed(db, { sensor: "browser_extension", observedAt: iso(0), ok: false, issues: [{ code: "duplicate_id", detail: "id m4 twice" }] });
    const h = captureHealthSummary(db);
    expect(h.healthy).toBe(false);
    const s = h.sensors[0]!;
    expect(s).toMatchObject({ observations: 4, failed: 3, degraded: true });
    expect(s.failureRate).toBeCloseTo(0.75);
    expect(s.lastFailureIssues).toEqual(["duplicate_id"]); // from the most recent failure
  });

  test("below the sample floor, a sensor is not marked degraded even at 100% failure", () => {
    const db = openDb(":memory:");
    seed(db, { sensor: "desktop_agent", observedAt: iso(1), ok: false, issues: [{ code: "no_messages", detail: "" }] });
    seed(db, { sensor: "desktop_agent", observedAt: iso(0), ok: false, issues: [{ code: "no_messages", detail: "" }] });
    const h = captureHealthSummary(db);
    expect(h.sensors[0]).toMatchObject({ observations: 2, failed: 2, degraded: false });
    expect(h.healthy).toBe(true);
  });

  test("observations outside the window are ignored", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 4; i++) seed(db, { sensor: "browser_extension", observedAt: iso(30 + i), ok: false, issues: [{ code: "bad_role", detail: "" }] });
    seed(db, { sensor: "browser_extension", observedAt: iso(1), ok: true });
    const h = captureHealthSummary(db, 7);
    expect(h.sensors[0]).toMatchObject({ observations: 1, failed: 0, degraded: false });
  });

  test("one degraded sensor makes the whole summary unhealthy even if another is fine", () => {
    const db = openDb(":memory:");
    for (let i = 0; i < 4; i++) seed(db, { sensor: "browser_extension", observedAt: iso(i), ok: true });
    for (let i = 0; i < 4; i++) seed(db, { sensor: "desktop_agent", observedAt: iso(i), ok: false, issues: [{ code: "single_role", detail: "" }] });
    const h = captureHealthSummary(db);
    expect(h.healthy).toBe(false);
    expect(h.sensors.find((s) => s.sensor === "browser_extension")?.degraded).toBe(false);
    expect(h.sensors.find((s) => s.sensor === "desktop_agent")?.degraded).toBe(true);
  });
});
