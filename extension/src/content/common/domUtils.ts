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
