import { dayKey, isoWeek } from "../analysis/activity";
import type { Metric } from "../analysis/types";
import type { Analysis } from "../analyze";
import { mcpLabels, modelExportId, riskExportToken, RISK_TOKENS } from "./allowlists";
import { canonicalJson } from "./jcs";
import { AIPROF2, CONFIG_KINDS, DURATION_ARCS, EDIT_LANGS, FEATURES, METRIC_KEYS, PROMPT_ARCS, sanitize, TECH_CATEGORIES, TOOLCHAINS, violations } from "./schema";

/**
 * How to export. `schema`: the payload schema (`aiprof/2`, the only one). `reveal`: projects the person chose to name,
 * by label (matched exactly, without regard to letter case: never a prefix); every other project stays a label. A label
 * that names no exported project, or more than one, is a `RevealError`; when two entries name the same label, the last
 * one wins.
 */
export interface ExportOptions { schema: "aiprof/2"; reveal?: Array<{ label: string; name: string }> }
/** The export: `value` is the payload, `json` its canonical bytes (RFC 8785), `bytes` their UTF-8 length; `JSON.parse(json)` deep-equals `value` (the preview contract). */
export interface ExportResult { schema: "aiprof/2"; value: unknown; json: string; bytes: number }

/**
 * The analysis does not fit the `aiprof/2` schema: some value would have been dropped or changed (a malformed interval,
 * an unknown status, a non-integer score, a text outside its form…). Nothing is exported then, since a payload that
 * claims more than the data supports must never be signed. Every failure of `exportPayload` is one (fail closed, one
 * error type): `stage` says where — `options` (no options object, or a schema other than aiprof/2), `reveal` (a
 * `RevealError`), `build` (the analysis could not be read: an unexpected
 * exception, whose own message is not kept since it may quote data), `check` (the draft does not fit the schema),
 * `serialize` (the canonical bytes could not be made). `paths` (and the message) name JSON paths only, never a value.
 */
export class ExportError extends Error {
  override readonly name: string = "ExportError";
  constructor(readonly paths: readonly string[], readonly stage: ExportStage = "check", message?: string) {
    const shown = paths.slice(0, MAX_PATHS_SHOWN);
    super(message ?? (paths.length > 0
      ? `exportPayload: the analysis does not fit aiprof/2 at ${shown.join(", ")}${paths.length > shown.length ? ` and ${paths.length - shown.length} more` : ""}`
      : `exportPayload: the export failed at the ${stage} stage`));
    OURS.add(this);
  }
}
export type ExportStage = "options" | "reveal" | "build" | "check" | "serialize";
/**
 * The errors this module made (a module-private brand): only those pass through a stage as they are. `instanceof` alone
 * could be spoofed by an object with a forged prototype; a WeakSet lookup runs no code of the value it is given.
 */
const OURS = new WeakSet<object>();
const ours = (e: unknown): boolean => {
  try {
    return typeof e === "object" && e !== null && OURS.has(e);
  } catch {
    return false;
  }
};

/**
 * A `reveal` label that names no exported project, or (`ambiguous`) more than one. The message quotes the label only
 * when it has a label's shape, and never the name.
 */
export class RevealError extends ExportError {
  override readonly name: string = "RevealError";
  constructor(label: string, ambiguous = false) {
    const shown = LABEL_SHAPE.test(label) ? ` "${label}"` : "";
    super([], "reveal", `exportPayload: the reveal label${shown} names ${ambiguous ? "more than one exported project" : "no exported project"}`);
  }
}
/** A project label's shape, any letter case: "P-" and 4, 6, 8 … 16 hex digits. */
const LABEL_SHAPE = /^P-(?:[0-9A-Fa-f]{2}){2,8}$/;

/** At most this many projects are exported, by sessions; the rest are counted in `otherProjects`. */
const MAX_PROJECTS = 100;
/** Exported weeks of the weekly activity: the latest 52. */
const MAX_WEEKS = 52;
/** At most this many model ids; the least used of the rest fold into "other" (counts summed). */
const MAX_MODELS = 64;
/** Caps of the lists whose length depends on the data (the schema's bounds). */
const MAX_COVERAGE = 64;
const MAX_EXPOSURE_TOOLS = 64;
const MAX_MCP = 256;
const MAX_BINDINGS = 64;
const MAX_PATHS_SHOWN = 20;
/** Fractions are exported to this many decimals (pre-flight P22), so the bytes never depend on a platform's last bit. */
const DECIMALS = 4;

/** `x` to 4 decimals, -0 as 0; a non-finite number stays as it is, so the schema check fails on it. */
const round = (x: number): number => {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** DECIMALS;
  return Math.round(x * f) / f + 0;
};
const roundOrNull = (x: number | null): number | null => (x === null ? null : round(x));
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Plain data keyed by arbitrary strings, without a prototype a key could reach. */
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
/** The entries of `h` under the keys of a vocabulary (anything else in `h` is not the payload's). */
function pick<T>(h: Partial<Record<string, T>>, keys: readonly string[]): Record<string, T> {
  const out = dict<T>();
  for (const k of keys) if (Object.hasOwn(h, k) && h[k] !== undefined) out[k] = h[k] as T;
  return out;
}

/**
 * The `aiprof/2` export of an analysis: the only payload that may leave the machine (spec §6.7). Fail closed:
 * 1. a builder maps the analysis to the payload's form (spans by month, first-seen times by ISO week, raw channels
 *    through the allowlists, fractions rounded to 4 decimals) and applies every cap (100 projects, the rest in
 *    `otherProjects`; 64 model ids, the rest in "other"; the latest 52 weeks);
 * 2. the draft is checked against `AIPROF2` (deny by default): a required field missing or undefined, or anything the
 *    schema would drop or change, is an `ExportError` naming the paths (`violations`), and nothing is exported;
 * 3. the payload is serialized canonically (RFC 8785).
 * `private` and `diagnostics` are never read, but for the allowlisted model ids and MCP labels. Pure and synchronous.
 */
export function exportPayload(a: Analysis, o: ExportOptions): ExportResult {
  stage("options", () => {
    if (typeof o !== "object" || o === null || o.schema !== "aiprof/2") throw new ExportError([], "options", "exportPayload: the only schema is aiprof/2");
  });
  const draft = stage("build", () => normalize(build(a, o)));
  const found = stage("check", () => violations(draft, AIPROF2));
  if (found.length > 0) throw new ExportError(found);
  const value = stage("check", () => sanitize(draft, AIPROF2));
  const paths = stage("check", () => differences(draft, value, "$", [])); // a second check: what the schema kept must be the draft, exactly
  if (paths.length > 0) throw new ExportError(paths);
  const json = stage("serialize", () => canonicalJson(value));
  return { schema: "aiprof/2", value, json, bytes: new TextEncoder().encode(json).length };
}

/** Runs one stage: an `ExportError` passes through; any other exception becomes one naming the stage (and no value). */
function stage<T>(name: ExportStage, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (ours(e)) throw e;
    throw new ExportError([], name);
  }
}

/** A count to add: a non-negative safe integer, else NaN, so a sum it enters fails the schema check (never absorbed). */
const countOf = (n: unknown): number => (typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : NaN);
/** `acc + n` over counts: NaN as soon as either is not a count. */
const addCount = (acc: number | undefined, n: unknown): number => (acc === undefined ? countOf(n) : acc + countOf(n));

/** The payload draft (see `exportPayload`). */
function build(a: Analysis, o: ExportOptions): Record<string, unknown> {
  const tz = a.meta.timeZone;
  // a time that is no finite number (a string already in the target form included) becomes NaN, so the schema check
  // fails on it: never silently absent, never passed through
  const month = (ms: unknown): unknown => (ms === undefined ? undefined : typeof ms === "number" && Number.isFinite(ms) ? dayKey(ms, tz).slice(0, 7) : NaN);
  const week = (ms: unknown): unknown => (typeof ms === "number" && Number.isFinite(ms) ? isoWeek(dayKey(ms, tz)) : NaN);
  const metric = (m: Metric): Record<string, unknown> => ({
    value: roundOrNull(m.value), n: m.n, window: m.window, from: month(m.from), to: month(m.to), reason: m.reason,
  });

  // reveal: by label, exactly but for letter case; the last entry for a label wins; every label must name exactly one
  // exported project (a label two projects share would put the name on both)
  const shown = a.projects.slice(0, MAX_PROJECTS);
  const rest = a.projects.slice(MAX_PROJECTS);
  const reveal = new Map<string, string>();
  for (const r of o.reveal ?? []) reveal.set(r.label.toUpperCase(), r.name);
  const exported = new Map<string, number>();
  for (const p of shown) exported.set(p.label.toUpperCase(), (exported.get(p.label.toUpperCase()) ?? 0) + 1);
  for (const r of o.reveal ?? []) {
    const n = exported.get(r.label.toUpperCase()) ?? 0;
    if (n !== 1) throw new RevealError(r.label, n > 1);
  }

  return {
    schema: "aiprof/2",
    core: a.meta.core,
    reference: a.meta.reference,
    coverage: a.coverage.rows.slice(0, MAX_COVERAGE).map((r) => ({
      tool: r.tool, window: r.window, statuses: r.sources.map((x) => x.status).sort(cmp), beta: r.sources.some((x) => x.beta),
      from: month(r.from), to: month(r.to), sessions: r.sessions, prompts: r.prompts, formatChanged: r.formatChanged,
    })),
    overall: { status: a.overall.status, score: a.overall.score, interval: a.overall.interval, band: a.overall.band, coverage: a.overall.coverage },
    dimensions: a.dimensions.map((d) => ({
      id: d.id, status: d.status, score: d.score, interval: d.interval, openTail: d.openTail, confidence: d.confidence, n: d.n, needs: d.needs,
      part: d.part, window: d.meta.window,
      components: d.components.map((c) => ({ id: c.id, status: c.status, x: roundOrNull(c.x), z: roundOrNull(c.z), n: c.n, weight: round(c.weight) })),
    })),
    personas: a.personas,
    signals: Object.fromEntries(METRIC_KEYS.map((k) => [k, metric(a.signals[k])])),
    exposure: {
      tenureWeeks: metric(a.exposure.tenureWeeks),
      activeWeeks: { detail: metric(a.exposure.activeWeeks.detail), lifetime: metric(a.exposure.activeWeeks.lifetime) },
      weekly: a.exposure.weekly.slice(-MAX_WEEKS).map((w) => ({ week: w.week, activeDays: w.activeDays, detailPrompts: w.detailPrompts, lifetimePrompts: w.lifetimePrompts })),
      tools: a.exposure.tools.slice(0, MAX_EXPOSURE_TOOLS).map((t) => ({
        tool: t.tool, window: t.window, sessions: t.sessions, prompts: t.prompts, actions: t.actions, from: month(t.from), to: month(t.to),
      })),
      rotation: { active90d: a.exposure.rotation.active90d, ever: a.exposure.rotation.ever },
      arcs: {
        prompts: pick(a.exposure.arcs.prompts, PROMPT_ARCS), medianPrompts: roundOrNull(a.exposure.arcs.medianPrompts),
        durations: pick(a.exposure.arcs.durations, DURATION_ARCS),
      },
      firstSeen: firstSeen(a, week),
      models: models(a.private.models),
    },
    stack: { languages: pick(a.stack.languages, EDIT_LANGS), toolchains: pick(a.stack.toolchains, TOOLCHAINS), techCategories: pick(a.stack.techCategories, TECH_CATEGORIES) },
    risk: { permission: risk("permission", a.risk.permission), approval: risk("approval", a.risk.approval), sandbox: risk("sandbox", a.risk.sandbox) },
    config: {
      byKind: Object.fromEntries(Object.entries(pick(a.config.byKind, CONFIG_KINDS)).map(([k, v]) =>
        [k, { authored: v.authored, installed: v.installed, other: v.other, used: v.used }])),
      hooksDisabled: a.config.hooksDisabled, memoryFiles: a.config.memoryFiles, mcpServers: mcpServers(a).slice(0, MAX_MCP),
    },
    projects: shown.map((p) => ({
      label: p.label, name: reveal.get(p.label.toUpperCase()), sessions: p.sessions, activeWeeks: p.activeWeeks, tools: p.tools, inRepo: p.inRepo,
      lastWeek: p.lastWeek,
    })),
    otherProjects: { projects: rest.length, sessions: rest.reduce<number>((s, p) => addCount(s, p.sessions), 0) },
    forensics: {
      band: a.forensics.band, serverBacked: roundOrNull(a.forensics.serverBacked), anchorable: a.forensics.anchorable, notAnchorable: a.forensics.notAnchorable,
      checks: a.forensics.checks.map((c) => ({
        id: c.id, status: c.status, n: c.n, reason: c.reason, values: copyValues(c.values), tools: c.tools, // never askAbout: no English text
      })),
    },
    identity: { accounts: a.identity.accounts, bindings: a.identity.hashes.slice(0, MAX_BINDINGS) },
    exclusions: { tools: a.exclusions.tools, projects: a.exclusions.projects, sessions: a.exclusions.sessions },
  };
}

/** Each feature's first evidence as its ISO week. */
function firstSeen(a: Analysis, week: (ms: unknown) => unknown): Record<string, unknown> {
  const out = dict<unknown>();
  for (const f of FEATURES) {
    const ms = a.exposure.firstSeen[f];
    if (ms !== undefined) out[f] = week(ms);
  }
  return out;
}

/**
 * Model counts under their export ids (`modelExportId`), summed. Over 64 ids, the 63 most used (then by id) stay and
 * the rest fold into "other" with "other" itself.
 */
function models(raw: Record<string, number>): Record<string, number> {
  const acc = new Map<string, number>();
  for (const [id, n] of Object.entries(raw)) {
    const k = modelExportId(id);
    acc.set(k, addCount(acc.get(k), n)); // a negative, fractional or non-number count fails the schema check
  }
  const out = dict<number>();
  if (acc.size <= MAX_MODELS) {
    for (const [k, n] of acc) out[k] = n;
    return out;
  }
  let other = acc.get("other") ?? 0;
  const ranked = [...acc].filter(([k]) => k !== "other").sort(([x, m], [y, n]) => n - m || cmp(x, y));
  for (const [k, n] of ranked.slice(0, MAX_MODELS - 1)) out[k] = n;
  for (const [, n] of ranked.slice(MAX_MODELS - 1)) other += n;
  out.other = other;
  return out;
}

/** A risk-posture table with unknown tokens folded into "other", counts summed. */
function risk(kind: keyof typeof RISK_TOKENS, h: Record<string, number>): Record<string, number> {
  const out = dict<number>();
  for (const [raw, n] of Object.entries(h)) {
    const k = riskExportToken(kind, raw);
    out[k] = addCount(out[k], n); // a negative, fractional or non-number count fails the schema check
  }
  return out;
}

/** The distinct MCP labels: public names sorted first, then custom #1, #2, … */
function mcpServers(a: Analysis): string[] {
  const custom = (l: string): number => (l.startsWith("custom #") ? Number(l.slice("custom #".length)) : 0);
  return [...new Set(mcpLabels(a.private.config).values())].sort((x, y) => custom(x) - custom(y) || cmp(x, y));
}

/**
 * A check's values as they are: core/forensics stores them rounded toward the side of their rule, and the reading side
 * rebuilds the question from exactly these numbers (`questionFor`), so they are not rounded again here.
 */
function copyValues(values: Record<string, unknown>): Record<string, unknown> {
  const out = dict<unknown>();
  for (const [k, v] of Object.entries(values)) out[k] = v;
  return out;
}

/** The draft as the schema would give it back when it fits: plain objects with sorted keys, no undefined, -0 as 0. */
function normalize(v: unknown): unknown {
  if (typeof v === "number") return v === 0 ? 0 : v;
  if (Array.isArray(v)) return v.map(normalize);
  if (v === null || typeof v !== "object") return v;
  const proto = Object.getPrototypeOf(v);
  if (proto !== null && proto !== Object.prototype) return v; // not plain data: the schema check rejects it
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) {
    const x = (v as Record<string, unknown>)[k];
    if (x !== undefined) Object.defineProperty(out, k, { value: normalize(x), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * The paths at which `got` (the sanitized draft) differs from `want` (the draft). It runs only after `violations` found
 * none, as a second check; it knows no key patterns, so every key is shown as "<key>".
 */
function differences(want: unknown, got: unknown, at: string, out: string[]): string[] {
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length) out.push(at);
    else want.forEach((x, i) => differences(x, got[i], `${at}[${i}]`, out));
  } else if (want !== null && typeof want === "object") {
    if (got === null || typeof got !== "object" || Array.isArray(got)) out.push(at);
    else {
      for (const k of Object.keys(want)) {
        const p = `${at}.<key>`;
        if (!Object.hasOwn(got, k)) out.push(p);
        else differences((want as Record<string, unknown>)[k], (got as Record<string, unknown>)[k], p, out);
      }
    }
  } else if (!Object.is(want, got)) out.push(at);
  return out;
}
