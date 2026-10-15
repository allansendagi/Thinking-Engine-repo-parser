/** Collapses whitespace and trims -- DOM text content often carries newlines/indentation noise. */
export function cleanText(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

/**
 * A short, stable hash of a string (FNV-1a, base36). Used to derive a message id from an
 * assistant turn's text, so a regenerated answer -- same position, different words -- gets a new
 * id and is captured, and a turn re-rendered at a shifted position after virtualized scrollback
 * keeps the same id. Not cryptographic; a collision within one conversation is vanishingly rare
 * and at worst merges two identical turns.
 */
export function textHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

/** First capturing group of the first pattern that matches `pathname`, or null. */
export function matchFirst(pathname: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pathname.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** First element matching any of `selectors`, in order, or null. */
export function firstMatch(root: ParentNode, selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    const el = root.querySelector<HTMLElement>(selector);
    if (el) return el;
  }
  return null;
}

function isEditable(el: HTMLElement): boolean {
  if (el.isContentEditable) return true;
  const attr = el.getAttribute("contenteditable");
  return attr === "" || attr === "true";
}

/** Caret to the end of a contenteditable, so the user lands after the inserted text. */
function caretToEnd(el: HTMLElement): void {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel) return;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}

/**
 * A synthetic paste of plain text. ProseMirror, Lexical, Slate and Quill all convert a
 * `text/plain` paste into a proper document mutation through their own model -- more reliable
 * across those editors than `execCommand` or writing `textContent`. No-ops where `ClipboardEvent`
 * / `DataTransfer` aren't constructable (the test env).
 */
function pasteText(el: HTMLElement, text: string): void {
  try {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
  } catch {
    /* not constructable here -- caller falls through to execCommand / textContent */
  }
}

/**
 * Put `text` into a message composer -- a `<textarea>`/`<input>` or a contenteditable (ProseMirror,
 * Lexical, Quill). Focuses it, leaves the caret at the end, does NOT submit.
 *
 * contenteditable path tries, in order: a synthetic `text/plain` paste (the editor's own model
 * runs), then `execCommand("insertText")`, then writing the node + a full `beforeinput`/`input`/
 * `change` burst. It only returns true if the text actually landed -- so a caller can hand off to
 * the Mac app rather than believe a silent failure.
 *
 * Returns false -- writing nothing -- if `el` is neither a text field nor editable, if it already
 * holds a non-whitespace draft (never clobber what the user typed), or if every insertion path
 * left the composer unchanged.
 */
export function fillComposer(el: HTMLElement, text: string): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    if (el.value.trim().length > 0) return false;
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.focus();
    try {
      el.setSelectionRange(text.length, text.length);
    } catch {
      /* some input types disallow selection */
    }
    return el.value.includes(text);
  }

  if (isEditable(el)) {
    if ((el.textContent ?? "").trim().length > 0) return false;
    el.focus();

    const has = () => (el.textContent ?? "").includes(text.slice(0, 40));

    pasteText(el, text);

    if (!has() && typeof document.execCommand === "function") {
      try {
        document.execCommand("insertText", false, text);
      } catch {
        /* deprecated / disabled in some builds */
      }
    }

    if (!has()) {
      el.textContent = text;
      for (const type of ["beforeinput", "input"] as const) {
        el.dispatchEvent(
          new InputEvent(type, {
            bubbles: true,
            cancelable: type === "beforeinput",
            inputType: "insertText",
            data: text,
          }),
        );
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    caretToEnd(el);
    return has();
  }

  return false;
}
