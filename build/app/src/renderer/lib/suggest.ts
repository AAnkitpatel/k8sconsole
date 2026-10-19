/** Ranks suggestions for the chip bar: prefix matches of the typed line first, then substring matches. */
export function rankSuggestions(all: string[], typed: string, limit = 8): string[] {
  const q = typed.trim();
  if (!q) return all.slice(0, limit);
  const pre = all.filter((s) => s.startsWith(q) && s !== q);
  const sub = all.filter((s) => !s.startsWith(q) && s.includes(q));
  return [...pre, ...sub].slice(0, limit);
}
