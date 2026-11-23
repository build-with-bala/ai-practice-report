import { localDay } from "../io/time";

/*
 * Locale-free, deterministic formatting for every number and date a report shows. No Intl and no toLocale*: digits come
 * from toFixed and String, separators and month names are fixed here, and dates go through localDay with an explicit
 * zone, so the output never depends on the process locale or zone. A value that is not a finite number prints "—".
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const NONE = "—";
const MINUS = "−";
const EN_DASH = "–";

/** `toFixed`, with a rounded negative zero written as zero. */
function fixed(x: number, digits: number): string {
  const s = x.toFixed(digits);
  return /^-0(?:\.0+)?$/.test(s) ? s.slice(1) : s;
}

/** A whole number with comma thousands; negatives take U+2212. */
function grouped(n: number): string {
  const r = Math.round(n);
  const digits = String(Math.abs(r)).replace(/\B(?=(\d{3})+$)/g, ",");
  return r < 0 ? MINUS + digits : digits;
}

/** `YYYY-MM-DD` in a zone, as numbers. */
function ymd(ms: number, timeZone: string): { y: string; m: number; d: number } {
  const [y, m, d] = localDay(ms, timeZone).split("-");
  return { y: y!, m: Number(m), d: Number(d) };
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
  /** A count with comma thousands. */
  count(n: number): string {
    return finite(n) ? grouped(n) : NONE;
  },
  /** `toFixed(digits)`, never `-0`. */
  decimal(x: number, digits: number): string {
    return finite(x) ? fixed(x, digits) : NONE;
  },
  /** A signed value: `+` or U+2212, and no sign when it rounds to zero. */
  signed(z: number, digits = 2): string {
    if (!finite(z)) return NONE;
    const abs = fixed(Math.abs(z), digits);
    if (/^0(?:\.0+)?$/.test(abs)) return abs;
    return (z < 0 ? MINUS : "+") + abs;
  },
  /** A token count: the integer below 1,000, then `k` with no decimals, then `M` with one decimal and no trailing `.0`. */
  tokens(n: number): string {
    if (!finite(n)) return NONE;
    const r = Math.round(n);
    if (Math.abs(r) < 1000) return String(r);
    const k = Math.round(n / 1000);
    if (Math.abs(k) < 1000) return `${k}k`;
    return `${fixed(n / 1_000_000, 1).replace(/\.0$/, "")}M`;
  },
  /** `N s` under a minute, `N min` under an hour, `H h M min` under 48 hours (`M min` dropped at 0), then `D d`. */
  duration(ms: number): string {
    if (!finite(ms)) return NONE;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const min = Math.round(ms / 60_000);
    if (min < 60) return `${min} min`;
    if (min < 48 * 60) {
      const h = Math.floor(min / 60);
      const m = min % 60;
      return m === 0 ? `${h} h` : `${h} h ${m} min`;
    }
    return `${Math.round(ms / 86_400_000)} d`;
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
  /** `2026-W47` → `W47 2026`. */
  week(isoWeek: string): string {
    const m = isoWeek.match(/^(\d{4})-W(\d{2})$/);
    return m ? `W${m[2]} ${m[1]}` : NONE;
  },
};
