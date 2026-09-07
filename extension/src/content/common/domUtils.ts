/** Collapses whitespace and trims -- DOM text content often carries newlines/indentation noise. */
export function cleanText(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
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

/**
 * Put `text` into a message composer -- a `<textarea>`/`<input>` or a contenteditable (ProseMirror,
 * Lexical, Quill). Sets the value the way React / the framework expects (native setter + a
 * bubbling `input` event, or `execCommand("insertText")` for contenteditable so the editor's own
 * pipeline runs), focuses it, and leaves the caret at the end. Does NOT submit.
 *
 * Returns false -- writing nothing -- if `el` is neither a text field nor editable, OR if it
 * already holds a non-whitespace draft. The caller must never clobber something the user typed;
 * a false here means "fall back to the hand-off".
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
    el.focus();
    try {
      el.setSelectionRange(text.length, text.length);
    } catch {
      /* some input types disallow selection */
    }
    return true;
  }

  if (isEditable(el)) {
    if ((el.textContent ?? "").trim().length > 0) return false;
    el.focus();
    const selection = typeof window !== "undefined" ? window.getSelection() : null;
    if (selection) {
      const all = document.createRange();
      all.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(all);
    }
    const viaCommand =
      typeof document.execCommand === "function" && document.execCommand("insertText", false, text);
    if (!viaCommand) {
      el.textContent = text;
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
      );
    }
    if (selection) {
      const end = document.createRange();
      end.selectNodeContents(el);
      end.collapse(false);
      selection.removeAllRanges();
      selection.addRange(end);
    }
    return true;
  }

  return false;
}
