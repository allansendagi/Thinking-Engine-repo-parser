import { Window } from "happy-dom";

/**
 * Adapters reference the global `document`/`location`/`Node` (as they naturally would running as
 * a real content script in a real page) rather than taking them as parameters. This shims those
 * globals with a happy-dom window for the duration of a test -- it's what lets adapter logic be
 * tested against constructed HTML without a real browser, while keeping production code written
 * the way a content script actually runs.
 */
export function setupDom(url: string, bodyHtml: string): Window {
  const window = new Window({ url });
  window.document.body.innerHTML = bodyHtml;

  const g = globalThis as unknown as Record<string, unknown>;
  g.document = window.document;
  g.location = window.location;
  g.Node = window.Node;

  return window;
}
