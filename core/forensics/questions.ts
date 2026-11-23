import type { CheckId, CheckResult, CheckValues, Reason } from "./types";

/*
 * The questions a result asks the person about. This is the only place their sentences live: each check sets its
 * `askAbout` by calling `questionFor`, and the reading side of an export (which carries `id`, `reason` and `values`,
 * never English text) calls it too, so both always say the same. Every sentence is fixed English whose only variable
 * parts are numbers and the date from `values`, within the characters Plan 3's fonts cover.
 */

type Ask = (v: CheckValues) => string | undefined;

const pct = (x: number): number => Math.round(x * 100);
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** Calls `f` with the named numbers of `v`, or gives undefined when one is missing. */
function nums<K extends keyof CheckValues>(v: CheckValues, keys: readonly K[], f: (...xs: number[]) => string): string | undefined {
  const xs: number[] = [];
  for (const k of keys) {
    const x = v[k];
    if (typeof x !== "number") return undefined;
    xs.push(x);
  }
  return f(...xs);
}

const missingStatsDays: Ask = (v) => nums(v, ["missingDays"], (m) =>
  `${m} ${plural(m, "day", "days")} with prompts in the transcripts ${plural(m, "is", "are")} missing from the usage statistics kept for that time. Were transcripts added from somewhere else?`);
const missingThreadRows: Ask = (v) => nums(v, ["missing"], (m) =>
  `${m} Codex session ${plural(m, "file has", "files have")} no entry in Codex's own thread index. Were session files copied in from somewhere else?`);

const QUESTIONS: { readonly [I in CheckId]?: { readonly [R in Reason]?: Ask } } = {
  C1: {
    "off-time": (v) => nums(v, ["offShare"], (s) =>
      `About ${Math.max(1, pct(s))}% of the server-issued ids do not match their recorded times, by more than 10 minutes. Were any trace times edited, or sessions added from somewhere else?`),
    "malformed-ids": (v) => nums(v, ["malformed"], (m) =>
      `${m} server-issued ids do not have the form the service issues. Were some sessions run through another provider or gateway?`),
  },
  C2: {
    "out-of-order": (v) => nums(v, ["rho"], (rho) =>
      `The order of the server-issued ids does not follow the order of their recorded times (rank correlation ${Math.floor(rho * 1_000) / 1_000}). Were trace files merged or their times edited?`),
  },
  C3: {
    "history-mismatch": (v) => nums(v, ["matchShare"], (s) =>
      `Only ${pct(s)}% of the typed prompts in the transcripts also appear in the prompt history. Was the history cleared, or were transcripts copied in from another machine?`),
    "missing-stats-days": missingStatsDays,
  },
  C4: {
    "no-match": () => "None of the sessions names the account this machine is signed in to. Were these sessions made under another account or on another machine?",
    "several-accounts": (v) => nums(v, ["accounts"], (a) => `The sessions name ${a} different accounts. Were several accounts used on this machine?`),
  },
  C5: {
    "file-times": (v) => nums(v, ["violations"], (n) =>
      `${n} trace files have file times that do not fit the events inside them: last modified before their last event, or changed more than a day after their last write. Were trace files edited, or their times reset?`),
    "restore-cluster": (v) => (v.date === undefined ? undefined : nums(v, ["days"], (d) =>
      `Most trace files were created on ${v.date} although their activity spans ${d} days. Was this history copied or restored from a backup then?`)),
    "bulk-change": (v) => (v.date === undefined ? undefined : nums(v, ["bulkFiles"], (n) =>
      `${n} trace files were last changed on ${v.date} although their content is older. Was this history copied, restored or migrated then?`)),
  },
  C6: { "missing-thread-rows": missingThreadRows },
  C7: {
    "uuid-after-name": (v) => nums(v, ["violations"], (n) =>
      `${n} Codex session ${plural(n, "id carries a time later than its file name", "ids carry a time later than their file names")}, by more than a second. Were session files renamed, or their ids edited?`),
    "time-zone-change": (v) => nums(v, ["zoneShifted"], (n) =>
      `${n} Codex session ${plural(n, "file is", "files are")} named in a different time zone from this machine's current one. Did the time zone change, or were the files made on another machine?`),
  },
  C8: {
    "ledger-contradictions": (v) => nums(v, ["contradictions"], (c) =>
      `The usage-limit readings fell ${c} times within one limit window, where they only rise. Were traces from more than one account combined here?`),
  },
  C9: {
    "before-release": (v) => nums(v, ["sessions"], (s) =>
      `${s} ${plural(s, "session", "sessions")} used a model or tool version more than 2 days before its public release. Were session times edited?`),
  },
  "soft:rhythm": {
    "regular-rhythm": (v) => nums(v, ["sessions"], (s) =>
      `Across ${s} ${plural(s, "session", "sessions")}, typed prompts arrive at unusually regular intervals. Were these prompts sent by a script rather than typed?`),
  },
  "soft:repeated-long": {
    "repeated-long": (v) => nums(v, ["repeated"], (r) =>
      `${r} long ${plural(r, "prompt", "prompts")} of 200 characters or more ${plural(r, "was", "were each")} sent 5 times or more. Were these prompts pasted from a template or sent by a script?`),
  },
  "soft:recent-burst": {
    "recent-burst": (v) => (v.date === undefined ? undefined : nums(v, ["share"], (s) =>
      `${pct(s)}% of the active days since ${v.date} fall in the 14 days before this scan. Was most of this history made just before the scan?`)),
  },
  "soft:unclosed-tools": {
    "unclosed-tools": (v) => nums(v, ["share"], (s) =>
      `${pct(s)}% of the tool calls in the Claude Code transcripts have no recorded result. Were transcripts cut short or edited?`),
  },
  "soft:new-config": {
    // raised means recent ≥ 3, so both counts are plural
    "new-config": (v) => nums(v, ["recent", "artifacts"], (r, m) =>
      `${r} of the ${m} tools and skills in use were first seen in the 7 days before this scan. Was this machine set up or migrated, or were its tools updated, in that week?`),
  },
};

/**
 * The question a result asks, from its `id`, `reason` and `values` alone: fixed English whose only variable parts are
 * numbers and the date of `values`. Undefined when that check and reason ask nothing, or when `values` lacks a number
 * the question needs. Pure.
 */
export function questionFor(id: CheckId, reason: Reason, values: CheckValues): string | undefined {
  return QUESTIONS[id]?.[reason]?.(values);
}

/** `r` with its `askAbout` set by `questionFor` (and none when it asks nothing). */
export function asked(r: CheckResult): CheckResult {
  const { askAbout: _, ...rest } = r;
  const q = questionFor(r.id, r.reason, r.values);
  return q === undefined ? rest : { ...rest, askAbout: q };
}
