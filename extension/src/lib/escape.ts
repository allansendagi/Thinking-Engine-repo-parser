/**
 * Escape text for use in HTML, in element content AND in quoted attributes. The previous version
 * (set textContent, read innerHTML) left quotes alone, so a title containing `"` could break out of
 * `value="..."` and add attributes to the element. Idea titles and sentences come from
 * conversations, which can contain anything.
 */
export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
