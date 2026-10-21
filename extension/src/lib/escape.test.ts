import { describe, expect, test } from "bun:test";
import { escapeHtml } from "./escape";

describe("escapeHtml", () => {
  test("neutralises markup and quote break-outs", () => {
    expect(escapeHtml(`<img src=x onerror=alert(1)>`)).toBe("&lt;img src=x onerror=alert(1)&gt;");
    expect(escapeHtml(`" autofocus onfocus="alert(1)`)).toBe("&quot; autofocus onfocus=&quot;alert(1)");
    expect(escapeHtml(`' onmouseover='x`)).toBe("&#39; onmouseover=&#39;x");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  test("tolerates non-strings", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(42)).toBe("42");
  });
});
