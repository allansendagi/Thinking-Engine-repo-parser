import { describe, expect, test } from "bun:test";
import { setupDom } from "../testUtils";
import { fillComposer, firstMatch } from "./domUtils";

describe("firstMatch", () => {
  test("returns the first selector that hits, in order", () => {
    const w = setupDom("https://x.test/", `<div id="a"></div><div class="b"></div>`);
    const root = w.document as unknown as ParentNode;
    expect(firstMatch(root, [".missing", "#a", ".b"])!.id).toBe("a");
    expect(firstMatch(root, [".missing", ".b"])!.className).toBe("b");
    expect(firstMatch(root, [".nope"])).toBeNull();
  });
});

describe("fillComposer", () => {
  test("sets a textarea value, fires input, and leaves the caret at the end", () => {
    const w = setupDom("https://x.test/", `<textarea id="c"></textarea>`);
    const el = w.document.getElementById("c") as unknown as HTMLTextAreaElement;
    let inputs = 0;
    el.addEventListener("input", () => inputs++);

    const ok = fillComposer(el as unknown as HTMLElement, "picking up where I left off");
    expect(ok).toBe(true);
    expect(el.value).toBe("picking up where I left off");
    expect(inputs).toBe(1);
    expect(el.selectionStart).toBe(el.value.length);
  });

  test("writes into a contenteditable and fires an input event", () => {
    const w = setupDom("https://x.test/", `<div id="c" contenteditable="true"></div>`);
    const el = w.document.getElementById("c") as unknown as HTMLElement;
    let inputs = 0;
    el.addEventListener("input", () => inputs++);

    const ok = fillComposer(el, "continue from here");
    expect(ok).toBe(true);
    expect(el.textContent).toBe("continue from here");
    expect(inputs).toBeGreaterThanOrEqual(1);
  });

  test("returns false for an element that is neither a field nor editable", () => {
    const w = setupDom("https://x.test/", `<div id="c"></div>`);
    const el = w.document.getElementById("c") as unknown as HTMLElement;
    expect(fillComposer(el, "nope")).toBe(false);
  });

  test("refuses to clobber a half-typed draft (textarea)", () => {
    const w = setupDom("https://x.test/", `<textarea id="c">half a question I was</textarea>`);
    const el = w.document.getElementById("c") as unknown as HTMLTextAreaElement;
    expect(fillComposer(el as unknown as HTMLElement, "checkpoint")).toBe(false);
    expect(el.value).toBe("half a question I was");
  });

  test("refuses to clobber a half-typed draft (contenteditable)", () => {
    const w = setupDom("https://x.test/", `<div id="c" contenteditable="true">draft in progress</div>`);
    const el = w.document.getElementById("c") as unknown as HTMLElement;
    expect(fillComposer(el, "checkpoint")).toBe(false);
    expect(el.textContent).toBe("draft in progress");
  });

  test("stops at the paste event when an editor handles it (doesn't also write textContent)", () => {
    const w = setupDom("https://x.test/", `<div id="c" contenteditable="true"></div>`);
    const el = w.document.getElementById("c") as unknown as HTMLElement;
    // Stand in for ProseMirror/Lexical: consume the paste and apply the text through the model.
    el.addEventListener("paste", (e) => {
      const t = (e as ClipboardEvent).clipboardData?.getData("text/plain") ?? "";
      el.textContent = t;
      e.preventDefault();
    });
    let inputs = 0;
    el.addEventListener("input", () => inputs++);

    const ok = fillComposer(el, "resume the verifier thread");
    expect(ok).toBe(true);
    expect(el.textContent).toBe("resume the verifier thread"); // exactly once, no double-append
    expect(inputs).toBe(0); // the fallback burst never ran
  });

  test("returns false when nothing takes -- so the caller hands off instead of believing a silent no-op", () => {
    const w = setupDom("https://x.test/", `<div id="c" contenteditable="true"></div>`);
    const el = w.document.getElementById("c") as unknown as HTMLElement;
    // An editor that swallows every insertion path and never actually changes.
    el.addEventListener("paste", (e) => e.preventDefault());
    el.addEventListener("beforeinput", (e) => e.preventDefault());
    const origExec = (w.document as unknown as { execCommand: unknown }).execCommand;
    (w.document as unknown as { execCommand: () => boolean }).execCommand = () => false;
    // Freeze textContent so even the last-resort write is inert.
    Object.defineProperty(el, "textContent", { get: () => "", set: () => {}, configurable: true });

    expect(fillComposer(el, "checkpoint")).toBe(false);
    (w.document as unknown as { execCommand: unknown }).execCommand = origExec;
  });
});
