/*
 * Locale-free, deterministic formatting for every number and date a report shows. Digits come from toFixed and String,
 * separators and month names are fixed here, and every negative number takes U+2212 MINUS SIGN (never an ASCII hyphen),
 * so the output never depends on the process locale or zone. A value that is not a finite number prints "—".
 *
 * The one use of Intl: a date's parts come from `Intl.DateTimeFormat("en-US", …).formatToParts` with an explicit zone,
 * the Gregorian calendar and Latin digits, read by part type rather than by splitting a formatted string. Like
 * `localDay`, it takes the zone from the caller, never from the process.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const NONE = "—";
const MINUS = "−";
const EN_DASH = "–";

/** `abs`, the formatted magnitude of `x`, with U+2212 in front when `x` is negative and `abs` is not a zero. */
function signOf(x: number, abs: string): string {
  return x < 0 && /[1-9]/.test(abs) ? MINUS + abs : abs;
}

/** `toFixed` with U+2212 for a negative, and a value that rounds to zero written without a sign. */
function fixed(x: number, digits: number): string {
  return signOf(x, Math.abs(x).toFixed(digits));
}

/** Digits with comma thousands. */
const commas = (digits: string): string => digits.replace(/\B(?=(\d{3})+$)/g, ",");

/**
 * A whole number with comma thousands; negatives take U+2212. Beyond 2^53 − 1 a number has no exact integer digits and
 * `String` would switch to exponent notation from 1e21, so it clamps: `>9,007,199,254,740,991`, or `<−9,…` below.
 */
function grouped(n: number): string {
  const r = Math.round(n);
  if (Math.abs(r) > Number.MAX_SAFE_INTEGER) return (r < 0 ? "<" + MINUS : ">") + commas(String(Number.MAX_SAFE_INTEGER));
  return signOf(r, commas(String(Math.abs(r))));
}

/** One parts formatter per zone: explicit locale, calendar and digits, so only the zone decides the date. */
const PART_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** The local date in a zone, as numbers, read from `formatToParts` by part type. */
function ymd(ms: number, timeZone: string): { y: string; m: number; d: number } {
  let f = PART_FORMATS.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "numeric", day: "numeric" });
    PART_FORMATS.set(timeZone, f);
  }
  const parts = f.formatToParts(ms);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  return { y: get("year"), m: Number(get("month")), d: Number(get("day")) };
}

/** The number of ISO weeks in a year: 53 when 1 January is a Thursday, or a Wednesday in a leap year; else 52. */
function isoWeeksIn(year: number): number {
  const jan1 = new Date(0);
  jan1.setUTCFullYear(year, 0, 1);
  const day = jan1.getUTCDay();
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day === 4 || (leap && day === 3) ? 53 : 52;
}

const finite = (x: number): boolean => Number.isFinite(x);

export const fmt = {
  /** A score as an integer. */
  score(n: number): string {
    return finite(n) ? fixed(n, 0) : NONE;
  },
  /** `[lo–hi]`, with an en dash. */
  interval(iv: readonly [number, number]): string {
    return `[${fmt.score(iv[0])}${EN_DASH}${fmt.score(iv[1])}]`;
  },
  /** A share as a whole percentage; `<1%` for a share above 0 that rounds to 0, `>99%` for one below 1 that rounds to 100. */
  share(x: number): string {
    if (!finite(x)) return NONE;
    if (x > 0 && x < 0.005) return "<1%";
    if (x >= 0.995 && x < 1) return ">99%";
    return `${fixed(100 * x, 0)}%`;
  },
  /** A count with comma thousands; clamped beyond 2^53 − 1, never in exponent notation. */
  count(n: number): string {
    return finite(n) ? grouped(n) : NONE;
  },
  /** `toFixed(digits)` with U+2212 for a negative, never `-0`. */
  decimal(x: number, digits: number): string {
    return finite(x) ? fixed(x, digits) : NONE;
  },
  /** A signed value: `+` or U+2212, and no sign when it rounds to zero. */
  signed(z: number, digits = 2): string {
    if (!finite(z)) return NONE;
    const out = fixed(z, digits);
    return z > 0 && /[1-9]/.test(out) ? "+" + out : out;
  },
  /** A token count: the integer below 1,000, then `k` with no decimals, then `M` with one decimal and no trailing `.0`. */
  tokens(n: number): string {
    if (!finite(n)) return NONE;
    const a = Math.abs(n);
    if (Math.round(a) < 1000) return signOf(n, String(Math.round(a)));
    const k = Math.round(a / 1000);
    if (k < 1000) return signOf(n, `${k}k`);
    return signOf(n, `${(a / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`);
  },
  /** `N s` under a minute, `N min` under an hour, `H h M min` under 48 hours (`M min` dropped at 0), then `D d`. */
  duration(ms: number): string {
    if (!finite(ms)) return NONE;
    const a = Math.abs(ms);
    const s = Math.round(a / 1000);
    const min = Math.round(a / 60_000);
    let out: string;
    if (s < 60) out = `${s} s`;
    else if (min < 60) out = `${min} min`;
    else if (min < 48 * 60) {
      const h = Math.floor(min / 60);
      const m = min % 60;
      out = m === 0 ? `${h} h` : `${h} h ${m} min`;
    } else out = `${Math.round(a / 86_400_000)} d`;
    return signOf(ms, out);
  },
  /** The local day in a zone: `18 Nov 2026`. */
  day(ms: number, timeZone: string): string {
    if (!finite(ms)) return NONE;
    const { y, m, d } = ymd(ms, timeZone);
    return `${d} ${MONTHS[m - 1]} ${y}`;
  },
  /** `2026-11` → `Nov 2026`. */
  month(ym: string): string {
    const m = ym.match(/^(\d{4})-(\d{2})$/);
    const i = m ? Number(m[2]) : 0;
    return m && i >= 1 && i <= 12 ? `${MONTHS[i - 1]} ${m[1]}` : NONE;
  },
  /** `Mar–Nov 2026` within a year, `Nov 2025–Mar 2026` across years, one month alone, `—` when either end is missing. */
  span(fromMs: number | undefined, toMs: number | undefined, timeZone: string): string {
    if (fromMs === undefined || toMs === undefined || !finite(fromMs) || !finite(toMs)) return NONE;
    const a = ymd(fromMs, timeZone);
    const b = ymd(toMs, timeZone);
    if (a.y !== b.y) return `${MONTHS[a.m - 1]} ${a.y}${EN_DASH}${MONTHS[b.m - 1]} ${b.y}`;
    if (a.m === b.m) return `${MONTHS[a.m - 1]} ${a.y}`;
    return `${MONTHS[a.m - 1]}${EN_DASH}${MONTHS[b.m - 1]} ${b.y}`;
  },
  /** `2026-W47` → `W47 2026`; a week the year does not have (`W00`, `W54`, `W53` in a 52-week year) prints `—`. */
  week(isoWeek: string): string {
    const m = isoWeek.match(/^(\d{4})-W(\d{2})$/);
    const w = m ? Number(m[2]) : 0;
    return m && w >= 1 && w <= isoWeeksIn(Number(m[1])) ? `W${m[2]} ${m[1]}` : NONE;
  },
};
