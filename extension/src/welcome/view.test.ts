import { describe, expect, test } from "bun:test";
import { DOWNLOAD_URL, PAIR_URL, welcomeView } from "./view";

describe("welcomeView", () => {
  test("paired wins, whatever the loopback says", () => {
    for (const d of ["absent", "closed", "open"] as const) {
      expect(welcomeView(true, d).step).toBe("connected");
    }
  });

  test("an open pairing window means it is connecting by itself -- no button", () => {
    const v = welcomeView(false, "open");
    expect(v.step).toBe("connecting");
    expect(v.primary).toBeUndefined();
  });

  test("app running, window closed: one click reopens it", () => {
    const v = welcomeView(false, "closed");
    expect(v.step).toBe("open-app");
    expect(v.primary?.href).toBe(PAIR_URL);
  });

  test("app absent: download first, with an escape hatch for 'installed but not running'", () => {
    const v = welcomeView(false, "absent");
    expect(v.step).toBe("download");
    expect(v.primary?.href).toBe(DOWNLOAD_URL);
    expect(v.secondary?.href).toBe(PAIR_URL);
  });
});
