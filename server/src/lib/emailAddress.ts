/** Extract one unambiguous sender address from a plain address or display-name form. */
export function normalizeEmailAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const matches = [...value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)];
  if (matches.length !== 1) return null;
  return matches[0][0].toLowerCase();
}
