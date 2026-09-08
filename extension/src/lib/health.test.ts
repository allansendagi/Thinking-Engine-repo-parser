import { describe, expect, test } from "bun:test";
import { _foldReport as fold } from "./storage";
import type { CaptureReport, SourceHealth } from "./types";

function report(over: Partial<CaptureReport> = {}): CaptureReport {
  return {
    source: "chatgpt",
    onConversation: true,
    containerPresent: true,
    extracted: 0,
    sent: 0,
    at: "2026-09-08T12:00:00.000Z",
    ...over,
  };
}

describe("capture-health fold", () => {
  test("a successful capture is 'ok' and stamps lastCaptureAt", () => {
    const h = fold(undefined, report({ extracted: 3, sent: 2 }));
    expect(h.state).toBe("ok");
    expect(h.lastCaptureAt).toBe("2026-09-08T12:00:00.000Z");
    expect(h.lastError).toBeNull();
  });

  test("extraction working but nothing new is still 'ok', no lastCaptureAt bump", () => {
    const prev: SourceHealth = fold(undefined, report({ extracted: 3, sent: 3 }));
    const h = fold(prev, report({ extracted: 3, sent: 0, at: "2026-09-08T12:05:00.000Z" }));
    expect(h.state).toBe("ok");
    expect(h.lastCaptureAt).toBe("2026-09-08T12:00:00.000Z");
  });

  test("no conversation open -> 'idle', streak reset", () => {
    const prev = fold(undefined, report({ containerPresent: true, extracted: 0 }));
    const h = fold(fold(prev, report()), report({ onConversation: false }));
    expect(h.state).toBe("idle");
    expect(h.emptyStreak).toBe(0);
  });

  test("one empty pass on a live page is tolerated; two in a row is 'degraded'", () => {
    const one = fold(undefined, report());
    expect(one.state).not.toBe("degraded");
    const two = fold(one, report({ at: "2026-09-08T12:00:30.000Z" }));
    expect(two.state).toBe("degraded");
    expect(two.detail).toMatch(/reload the tab/i);
  });

  test("empty but container absent = still loading, not degraded", () => {
    const a = fold(undefined, report({ containerPresent: false }));
    const b = fold(a, report({ containerPresent: false, at: "2026-09-08T12:00:30.000Z" }));
    expect(b.state).not.toBe("degraded");
  });

  test("a thrown pass is 'error' and carries the message", () => {
    const h = fold(fold(undefined, report({ extracted: 2, sent: 2 })), report({ error: "401 unauthorized" }));
    expect(h.state).toBe("error");
    expect(h.lastError).toBe("401 unauthorized");
  });

  test("recovers to 'ok' after a good pass following a degrade", () => {
    let h = fold(undefined, report());
    h = fold(h, report({ at: "2026-09-08T12:00:30.000Z" })); // degraded now
    expect(h.state).toBe("degraded");
    h = fold(h, report({ extracted: 4, sent: 1, at: "2026-09-08T12:01:00.000Z" }));
    expect(h.state).toBe("ok");
    expect(h.emptyStreak).toBe(0);
  });
});
