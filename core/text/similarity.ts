function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function shingles(s: string, k: number): Set<string> {
  if (s.length < k) return new Set([s]);
  const out = new Set<string>();
  for (let i = 0; i + k <= s.length; i++) out.add(s.slice(i, i + k));
  return out;
}

/** Jaccard similarity of k-char shingles after lowercasing and whitespace collapse; empty → 0. */
export function shingleSimilarity(a: string, b: string, k = 5): number {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  const sa = shingles(na, k);
  const sb = shingles(nb, k);
  if (na.length < k || nb.length < k) return na === nb ? 1 : 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}
