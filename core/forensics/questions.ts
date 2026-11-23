import { isValueOf, VALUE_KINDS, type CheckId, type CheckResult, type CheckValues, type Reason, type ValueKey } from "./types";

/*
 * The questions a result asks the person about. This is the only place their sentences live: each check sets its
 * `askAbout` by calling `questionFor`, and the reading side of an export (which carries `id`, `reason` and `values`,
 * never English text) calls it too, so both always say the same.
 *
 * The reading side calls it on data it did not make, so it trusts nothing: a question is built only when every value it
 * uses is valid by its kind in `VALUE_KINDS` (types.ts, the table the export schema reads too), and it prints every number itself (`digits`), never through
 * default string conversion. Every sentence is fixed English whose only variable parts are those numbers and the day,
 * within the characters Plan 3's fonts cover.
 *
 * Numbers are shown rounded toward the side of the rule the result is on, as they are stored (types.ts, `roundDown`):
 * a correlation under a "below" rule to 3 decimals, down; a share under a "below" rule as a whole percentage, down; a
 * share under an "above" rule as a percentage to one decimal, up.
 */

const DIGITS = "0123456789";

/** A non-negative safe integer, written out digit by digit. */
function digits(n: number): string {
  let s = "";
  let x = n;
  do {
    s = DIGITS[x % 10]! + s;
    x = Math.floor(x / 10);
  } while (x > 0);
  return s;
}
/** `units` / 10^`places` (an integer scaled by 10^places), with its sign and without trailing zeros. */
function decimal(units: number, places: number): string {
  const neg = units < 0, a = Math.abs(units), f = 10 ** places;
  const whole = Math.floor(a / f);
  let frac = places === 0 ? "" : digits(a % f).padStart(places, "0").replace(/0+$/, "");
  if (frac !== "") frac = `.${frac}`;
  return `${neg && a > 0 ? "-" : ""}${digits(whole)}${frac}`;
}

/**
 * The value under `k`, read once, when it is valid by the key's kind in `VALUE_KINDS`; else undefined. The call site
 * names only the key: its kind (and so its check) comes from the shared table.
 */
function num(v: CheckValues, k: Exclude<ValueKey, "date">): number | undefined {
  const x: unknown = v[k];
  return isValueOf(VALUE_KINDS[k], x) ? (x as number) : undefined;
}
function dayOf(v: CheckValues): string | undefined {
  const x: unknown = v.date;
  return isValueOf(VALUE_KINDS.date, x) ? (x as string) : undefined;
}

// a stored value has 4 decimals; read it as an integer number of 10^−4 units (the epsilon only absorbs float error)
const EPS = 1e-6;
/** A share as a whole percentage, rounded down. */
const pctDown = (s: number): string => decimal(Math.floor((Math.floor(s * 1e4 + EPS)) / 100), 0);
/** A share as a percentage to one decimal, rounded up. */
const pctUp1 = (s: number): string => decimal(Math.ceil(Math.ceil(s * 1e4 - EPS) / 10), 1);
/** A correlation to 3 decimals, rounded down. */
const corrDown3 = (r: number): string => decimal(Math.floor(Math.floor(r * 1e4 + EPS) / 10), 3);

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

type Ask = (v: CheckValues) => string | undefined;

const missingStatsDays: Ask = (v) => {
  const m = num(v, "missingDays");
  return m === undefined ? undefined
    : `${digits(m)} ${plural(m, "day", "days")} with prompts in the transcripts ${plural(m, "is", "are")} missing from the usage statistics kept for that time. Were transcripts added from somewhere else?`;
};
const missingThreadRows: Ask = (v) => {
  const m = num(v, "missing");
  return m === undefined ? undefined
    : `${digits(m)} Codex session ${plural(m, "file has", "files have")} no entry in Codex's own thread index. Were session files copied in from somewhere else?`;
};

const QUESTIONS: { readonly [I in CheckId]?: { readonly [R in Reason]?: Ask } } = {
  C1: {
    "off-time": (v) => {
      const s = num(v, "offShare");
      return s === undefined ? undefined
        : `About ${pctUp1(s)}% of the server-issued ids do not match their recorded times, by more than 10 minutes. Were any trace times edited, or sessions added from somewhere else?`;
    },
    "malformed-ids": (v) => {
      const m = num(v, "malformed");
      return m === undefined ? undefined
        : `${digits(m)} server-issued ids do not have the form the service issues. Were some sessions run through another provider or gateway?`;
    },
  },
  C2: {
    "out-of-order": (v) => {
      const r = num(v, "rho");
      return r === undefined ? undefined
        : `The order of the server-issued ids does not follow the order of their recorded times (rank correlation ${corrDown3(r)}). Were trace files merged or their times edited?`;
    },
  },
  C3: {
    "history-mismatch": (v) => {
      const s = num(v, "matchShare");
      return s === undefined ? undefined
        : `Only ${pctDown(s)}% of the typed prompts in the transcripts also appear in the prompt history. Was the history cleared, or were transcripts copied in from another machine?`;
    },
    "missing-stats-days": missingStatsDays,
  },
  C4: {
    "no-match": () => "None of the sessions names the account this machine is signed in to. Were these sessions made under another account or on another machine?",
    "several-accounts": (v) => {
      const a = num(v, "accounts");
      return a === undefined ? undefined : `The sessions name ${digits(a)} different accounts. Were several accounts used on this machine?`;
    },
  },
  C5: {
    "file-times": (v) => {
      const n = num(v, "violations");
      return n === undefined ? undefined
        : `${digits(n)} trace files have file times that do not fit the events inside them: last modified before their last event, or changed more than a day after their last write. Were trace files edited, or their times reset?`;
    },
    "restore-cluster": (v) => {
      const d = dayOf(v), n = num(v, "days");
      return d === undefined || n === undefined ? undefined
        : `Most trace files were created on ${d} although their activity spans ${digits(n)} days. Was this history copied or restored from a backup then?`;
    },
    "bulk-change": (v) => {
      const d = dayOf(v), n = num(v, "bulkFiles");
      return d === undefined || n === undefined ? undefined
        : `${digits(n)} trace files were last changed on ${d} although their content is older. Was this history copied, restored or migrated then?`;
    },
  },
  C6: { "missing-thread-rows": missingThreadRows },
  C7: {
    "uuid-after-name": (v) => {
      const n = num(v, "violations");
      return n === undefined ? undefined
        : `${digits(n)} Codex session ${plural(n, "id carries a time later than its file name", "ids carry a time later than their file names")}, by more than a second. Were session files renamed, or their ids edited?`;
    },
    "time-zone-change": (v) => {
      const n = num(v, "zoneShifted");
      return n === undefined ? undefined
        : `${digits(n)} Codex session ${plural(n, "file is", "files are")} named in a different time zone from this machine's current one. Did the time zone change, or were the files made on another machine?`;
    },
  },
  C8: {
    "ledger-contradictions": (v) => {
      const c = num(v, "contradictions");
      return c === undefined ? undefined
        : `The usage-limit readings fell ${digits(c)} times within one limit window, where they only rise. Were traces from more than one account combined here?`;
    },
  },
  C9: {
    "before-release": (v) => {
      const s = num(v, "sessions");
      return s === undefined ? undefined
        : `${digits(s)} ${plural(s, "session", "sessions")} used a model or tool version more than 2 days before its public release. Were session times edited?`;
    },
  },
  "soft:rhythm": {
    "regular-rhythm": (v) => {
      const s = num(v, "sessions");
      return s === undefined ? undefined
        : `Across ${digits(s)} ${plural(s, "session", "sessions")}, typed prompts arrive at unusually regular intervals. Were these prompts sent by a script rather than typed?`;
    },
  },
  "soft:repeated-long": {
    "repeated-long": (v) => {
      const r = num(v, "repeated");
      return r === undefined ? undefined
        : `${digits(r)} long ${plural(r, "prompt", "prompts")} of 200 characters or more ${plural(r, "was", "were each")} sent 5 times or more. Were these prompts pasted from a template or sent by a script?`;
    },
  },
  "soft:recent-burst": {
    "recent-burst": (v) => {
      const r = num(v, "recentDays"), d = num(v, "days"), s = num(v, "spanDays");
      return r === undefined || d === undefined || s === undefined ? undefined
        : `${digits(r)} of the ${digits(d)} active ${plural(d, "day", "days")}, which span ${digits(s)} ${plural(s, "day", "days")}, fall in the 14 days before this scan. Was most of this history made just before the scan?`;
    },
  },
  "soft:unclosed-tools": {
    "unclosed-tools": (v) => {
      const s = num(v, "share");
      return s === undefined ? undefined
        : `${pctUp1(s)}% of the tool calls in the Claude Code transcripts have no recorded result. Were transcripts cut short or edited?`;
    },
  },
  "soft:new-config": {
    "new-config": (v) => {
      const r = num(v, "recent"), m = num(v, "artifacts");
      return r === undefined || m === undefined ? undefined
        : `${digits(r)} of the ${digits(m)} ${plural(m, "tool or skill", "tools and skills")} in use ${plural(r, "was", "were")} first seen in the 7 days before this scan. Was this machine set up or migrated, or were its tools updated, in that week?`;
    },
  },
};

/**
 * The question a result asks, from its `id`, `reason` and `values` alone: fixed English whose only variable parts are
 * numbers and the day of `values`. Undefined for an unknown `id` or `reason`, when that check and reason ask nothing,
 * or when a value the question uses is missing or invalid (a count that is no non-negative safe integer, a share
 * outside 0 to 1, a correlation outside −1 to 1, a day that is no real calendar day "YYYY-MM-DD"). Pure.
 */
export function questionFor(id: unknown, reason: unknown, values: unknown): string | undefined {
  // strings only, each looked up once: a non-string id or reason (with a changing or throwing toString) never reaches
  // a property lookup; and a throwing getter in values gives no question rather than an exception
  if (typeof id !== "string" || typeof reason !== "string" || typeof values !== "object" || values === null) return undefined;
  try {
    const byReason = Object.hasOwn(QUESTIONS, id) ? QUESTIONS[id as CheckId] : undefined;
    if (byReason === undefined) return undefined;
    const ask = Object.hasOwn(byReason, reason) ? byReason[reason as Reason] : undefined;
    return ask === undefined ? undefined : ask(values as CheckValues);
  } catch {
    return undefined;
  }
}

/** `r` with its `askAbout` set by `questionFor` (and none when it asks nothing). */
export function asked(r: CheckResult): CheckResult {
  const { askAbout: _, ...rest } = r;
  const q = questionFor(r.id, r.reason, r.values);
  return q === undefined ? rest : { ...rest, askAbout: q };
}
