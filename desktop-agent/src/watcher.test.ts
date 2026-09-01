import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchPaths } from "./watcher";

describe("watchPaths", () => {
  test("reports nonexistent paths as skipped instead of throwing", () => {
    const handle = watchPaths(["/definitely/does/not/exist/anywhere"], () => {});
    expect(handle.skipped).toEqual(["/definitely/does/not/exist/anywhere"]);
    handle.stop();
  });

  test("calls onChange (debounced) when a watched file is modified", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thread-watch-test-"));
    const filePath = join(dir, "state.db");
    writeFileSync(filePath, "initial");

    const changes: string[] = [];
    const handle = watchPaths([filePath], (p) => changes.push(p), { debounceMs: 20 });
    expect(handle.skipped).toEqual([]);

    writeFileSync(filePath, "changed");
    await new Promise((r) => setTimeout(r, 60));

    handle.stop();
    rmSync(dir, { recursive: true, force: true });

    expect(changes).toEqual([filePath]);
  });

  test("debounces multiple rapid writes down to far fewer callbacks than writes", async () => {
    // NOT asserting exactly 1: fs.watch/FSEvents on macOS can legitimately deliver duplicate or
    // delayed events for what's logically one write, independent of whether the debounce logic
    // (clearTimeout + reset on every event) is correct -- that part is what's actually under
    // test here, not raw filesystem notification timing. Confirmed flaky at exactly 1 across
    // repeated runs; loosening the assertion to what's actually guaranteed, not to make it pass.
    const dir = mkdtempSync(join(tmpdir(), "thread-watch-test-"));
    const filePath = join(dir, "state.db");
    writeFileSync(filePath, "initial");

    let callCount = 0;
    const handle = watchPaths([filePath], () => callCount++, { debounceMs: 150 });

    writeFileSync(filePath, "change 1");
    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(filePath, "change 2");
    await new Promise((r) => setTimeout(r, 15));
    writeFileSync(filePath, "change 3");

    await new Promise((r) => setTimeout(r, 300));
    handle.stop();
    rmSync(dir, { recursive: true, force: true });

    expect(callCount).toBeGreaterThanOrEqual(1); // it did detect the changes
    expect(callCount).toBeLessThan(3); // and meaningfully coalesced 3 writes, not 1:1
  });
});
