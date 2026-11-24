const MIN_MS = Date.UTC(2015, 0, 1);
const TWO_DAYS = 2 * 86_400_000;
const SECONDS_CUTOFF = 1e11; // below this a number is epoch seconds

/**
 * Epoch ms from seconds, ms, numeric strings or date strings; undefined if implausible. A date string is read as
 * `Date.parse` reads it: with a zone (`Z`, `+05:30`) at that zone; a date-time with no zone (`2026-11-20T10:00:00`) in
 * the process time zone; a date alone (`2026-11-20`) as the start of that day in UTC. Every format a reader is known
 * to meet carries a zone, so the two zone-less rules apply only to odd data.
 */
export function toEpochMs(v: unknown, now: number = Date.now()): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? plausible(scale(v), now) : undefined;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (s === "") return undefined;
  if (/^-?\d+(\.\d+)?$/.test(s)) return plausible(scale(Number(s)), now);
  return plausible(Date.parse(s), now);
}

/**
 * Why a value gave no time (`toEpochMs` undefined): `shape` — absent, or of no shape a time has, so the field moved or
 * changed (format drift) — or `implausible`: a well-formed time outside the plausible range (bad data).
 */
export function timeIssue(v: unknown): "shape" | "implausible" {
  if (typeof v === "number") return Number.isFinite(v) ? "implausible" : "shape";
  if (typeof v !== "string") return "shape";
  const s = v.trim();
  return s !== "" && (/^-?\d+(\.\d+)?$/.test(s) || Number.isFinite(Date.parse(s))) ? "implausible" : "shape";
}

function scale(n: number): number {
  return Math.abs(n) < SECONDS_CUTOFF ? n * 1000 : n;
}

/**
 * `ms` when it is a plausible time (finite, not before 2015, at most two days after `now`), else undefined: the one
 * bound every time a reader emits goes through.
 */
export function plausible(ms: number, now: number): number | undefined {
  if (!Number.isFinite(ms)) return undefined;
  if (ms < MIN_MS || ms > now + TWO_DAYS) return undefined;
  return ms;
}

/**
 * One formatter per zone: building an Intl.DateTimeFormat costs about 60× a format call. The process zone is keyed by
 * the current `process.env.TZ` (a formatter fixes its zone when built), so changing TZ still changes the default zone.
 */
const DAY_FORMATS = new Map<string, Intl.DateTimeFormat>();

function dayFormat(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? `process:${process.env.TZ ?? ""}`;
  let f = DAY_FORMATS.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    DAY_FORMATS.set(key, f);
  }
  return f;
}

/** "YYYY-MM-DD" in the given IANA zone (default: the process zone, honouring process.env.TZ). */
export function localDay(ms: number, timeZone?: string): string {
  return dayFormat(timeZone).format(ms);
}
