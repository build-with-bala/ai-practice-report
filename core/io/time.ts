const MIN_MS = Date.UTC(2015, 0, 1);
const TWO_DAYS = 2 * 86_400_000;
const SECONDS_CUTOFF = 1e11; // below this a number is epoch seconds

/** Epoch ms from seconds, ms, numeric strings or date strings; undefined if implausible. */
export function toEpochMs(v: unknown, now: number = Date.now()): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? plausible(scale(v), now) : undefined;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (s === "") return undefined;
  if (/^-?\d+(\.\d+)?$/.test(s)) return plausible(scale(Number(s)), now);
  return plausible(Date.parse(s), now);
}

function scale(n: number): number {
  return Math.abs(n) < SECONDS_CUTOFF ? n * 1000 : n;
}

function plausible(ms: number, now: number): number | undefined {
  if (!Number.isFinite(ms)) return undefined;
  if (ms < MIN_MS || ms > now + TWO_DAYS) return undefined;
  return ms;
}

/** "YYYY-MM-DD" in the given IANA zone (default: the process zone, honouring process.env.TZ). */
export function localDay(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
}
