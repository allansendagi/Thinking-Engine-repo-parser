import { describe, expect, test } from "bun:test";
import manifest from "../manifest.json";
import { TRUSTED_API_ORIGINS } from "./lib/apiOrigin";

/**
 * Guards what the extension is allowed to touch. A change that widens this should be a decision,
 * not an accident: Chrome also disables the extension for every user until they accept a wider
 * permission set.
 */
const AI_SITES = [
  "https://chatgpt.com/*",
  "https://chat.openai.com/*",
  "https://claude.ai/*",
  "https://gemini.google.com/*",
  "https://www.perplexity.ai/*",
  "https://perplexity.ai/*",
];

describe("manifest", () => {
  test("host access is exactly: the AI sites, Thread's own servers, and this computer for pairing", () => {
    const expected = [...AI_SITES, ...TRUSTED_API_ORIGINS.map((o) => `${o}/*`), "http://127.0.0.1/*"].sort();
    expect([...manifest.host_permissions].sort()).toEqual(expected);
  });

  test("no broad host access and no unencrypted host other than this computer", () => {
    for (const h of manifest.host_permissions) {
      expect(h).not.toContain("<all_urls>");
      expect(h).not.toMatch(/^\*|:\/\/\*/);
      if (h.startsWith("http://")) expect(h).toBe("http://127.0.0.1/*");
    }
  });

  test("content scripts run only on the AI sites", () => {
    for (const cs of manifest.content_scripts) {
      for (const m of cs.matches) expect(AI_SITES).toContain(m);
    }
  });

  test("API permissions stay the small set we use", () => {
    expect([...manifest.permissions].sort()).toEqual(["activeTab", "alarms", "contextMenus", "scripting", "sidePanel", "storage"]);
  });

  test("extension pages run only our own scripts: no remote code, no plugins, no inline script", () => {
    const csp = manifest.content_security_policy.extension_pages;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
    expect(csp).toContain("object-src 'none'");
  });

  test("nothing is exposed to web pages or other extensions", () => {
    expect(manifest).not.toHaveProperty("web_accessible_resources");
    expect(manifest).not.toHaveProperty("externally_connectable");
  });
});
