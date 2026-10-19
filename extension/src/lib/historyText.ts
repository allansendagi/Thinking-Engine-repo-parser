/** History import messages shared by the page pill and the popup. */
/** What went wrong, in words that point at the real cause. */
export function historyErrorText(error: string | undefined): string {
  const status = Number(error?.match(/\b(\d{3})\b/)?.[1] ?? 0);
  if (status === 401 || status === 403) return "you're not signed in here — sign in, then try again.";
  if (status === 429) return "the site is limiting requests right now — try again in a few minutes.";
  if (status >= 500) return `the site's server didn't answer (${status}) — try again in a minute. Nothing is lost.`;
  return `couldn't read your history here (${error ?? "unknown error"}).`;
}
