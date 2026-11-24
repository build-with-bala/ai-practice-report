import type { Feature, DurationArc, PromptArc } from "../analysis/exposure";
import type { RepoSignals } from "../git/types";
import type { ConfigEv, CoverageEv } from "../model/events";
import type { TechCategory, Toolchain, ToolId, Window } from "../model/ids";
import type { CheckId, CheckStatus, Forensics } from "../forensics/index";
import { DATE_KEY, isDay, REASONS, VALUE_KEYS, VALUE_KINDS, type Reason, type ValueKey, type ValueKind } from "../forensics/types";
import { COMPONENTS, type MetricKey } from "../scoring/components";
import { DIMENSION_IDS } from "../scoring/dimensions";
import type { Band } from "../scoring/overall";
import { PRACTICE_ROLES, STACK_ROLES } from "../scoring/roles";
import type { Metric } from "../analysis/types";
import type { Evidence } from "../signals/types";
import type { EditLang } from "../text/langs";
import { MCP_PUBLIC, modelExportId, RISK_TOKENS } from "./allowlists";

/**
 * The sensitivity class of an exported value (spec §6.7): `public` (fixed vocabulary), `aggregate` (counts, rates,
 * scores), `pseudonymous` (keyed hashes and opaque labels), `revealed` (a name the person chose to reveal).
 */
export type Sensitivity = "public" | "aggregate" | "pseudonymous" | "revealed";

/**
 * One declared field of the export. Leaves carry their sensitivity class: `count` is a non-negative safe integer (every
 * count of the payload), `integer` a signed one (no payload field needs a sign today), `number` any finite number,
 * `bounded` a finite number in [min, max] (shares, weights, correlations, scores), with at most `decimals` decimals
 * when given (0: an integer), `day` a real calendar day "YYYY-MM-DD"
 * (`isDay`). A `variant` is an object whose string field `tag` picks the spec in `cases` it must fit.
 * `nullable`, `optional`, `array` (at most `max` elements),
 * `tuple` (exactly one element per spec in `of`, all or nothing), `object` (exactly the declared `fields`) and `record`
 * (keys matching `key`, at most `maxKeys`, each value by `of`, or by its own spec in `fields` for a declared key) compose
 * them. A field of an object spec is required: present, not undefined, and allowed. Only `optional` marks a field that
 * may be absent (`null` is a value, for `nullable`). Every pattern is anchored at both ends.
 */
export type FieldSpec =
  | { t: "number" | "integer" | "count" | "boolean"; s: Sensitivity } | { t: "bounded"; min: number; max: number; decimals?: number; s: Sensitivity }
  | { t: "day"; s: Sensitivity } | { t: "optional"; of: FieldSpec } | { t: "variant"; tag: string; cases: Readonly<Record<string, FieldSpec>> } | { t: "enum"; values: readonly string[]; s: Sensitivity }
  | { t: "string"; pattern: RegExp; s: Sensitivity } | { t: "nullable"; of: FieldSpec }
  | { t: "array"; of: FieldSpec; max: number } | { t: "tuple"; of: readonly FieldSpec[] } | { t: "object"; fields: Readonly<Record<string, FieldSpec>> }
  | { t: "record"; key: KeyTest; of: FieldSpec; maxKeys: number; fields?: Readonly<Record<string, FieldSpec>> };
/** What a record key must pass: an anchored pattern, or a predicate in the same shape. */
export interface KeyTest { test(key: string): boolean }

/**
 * A value as the schema allows it (deny by default), or `undefined` when it is not allowed at all:
 * - an object keeps only its declared, own fields; it is dropped whole when a required field is missing, undefined or
 *   not allowed, and an optional field that is not allowed is left out; a record keeps only own keys matching its key
 *   pattern (in key order, at most `maxKeys`) whose values are allowed; anything that is not a plain object is dropped;
 * - an array keeps its allowed elements, at most `max` of them; a tuple is kept whole or not at all: it must have
 *   exactly its length, and every element must be allowed;
 * - a number must be finite (an integer a safe integer, a count a non-negative one), -0 becomes 0; a string must match its pattern, an enum be one
 *   of its values; a boolean be a boolean.
 * The result is fresh plain data: nothing of the input is shared with it. Pure and synchronous.
 */
export function sanitize(value: unknown, spec: FieldSpec): unknown {
  switch (spec.t) {
    case "number": return typeof value === "number" && Number.isFinite(value) ? value + 0 : undefined;
    case "integer": return typeof value === "number" && Number.isSafeInteger(value) ? value + 0 : undefined;
    case "bounded": return typeof value === "number" && Number.isFinite(value) && value >= spec.min && value <= spec.max && hasDecimals(value, spec.decimals)
      ? value + 0 : undefined;
    case "count": return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value + 0 : undefined;
    case "day": return isDay(value) ? value : undefined;
    case "optional": return sanitize(value, spec.of);
    case "variant": {
      const c = variantCase(value, spec);
      return c === undefined ? undefined : sanitize(value, c);
    }
    case "boolean": return typeof value === "boolean" ? value : undefined;
    case "enum": return typeof value === "string" && spec.values.includes(value) ? value : undefined;
    case "string": return typeof value === "string" && spec.pattern.test(value) ? value : undefined;
    case "nullable": return value === null ? null : sanitize(value, spec.of);
    case "array": {
      if (!Array.isArray(value)) return undefined;
      const out: unknown[] = [];
      for (const x of value) {
        if (out.length >= spec.max) break;
        const y = sanitize(x, spec.of);
        if (y !== undefined) out.push(y);
      }
      return out;
    }
    case "tuple": {
      if (!Array.isArray(value) || value.length !== spec.of.length) return undefined;
      const out: unknown[] = [];
      for (let i = 0; i < spec.of.length; i++) {
        const y = sanitize(value[i], spec.of[i]!);
        if (y === undefined) return undefined;
        out.push(y);
      }
      return out;
    }
    case "object": {
      if (!isPlainObject(value)) return undefined;
      const out: Record<string, unknown> = {};
      for (const [k, f] of Object.entries(spec.fields)) {
        const present = Object.hasOwn(value, k) && value[k] !== undefined;
        if (!present) {
          if (f.t === "optional") continue;
          return undefined;
        }
        const y = sanitize(value[k], f);
        if (y !== undefined) define(out, k, y);
        else if (f.t !== "optional") return undefined;
      }
      return out;
    }
    case "record": {
      if (!isPlainObject(value)) return undefined;
      const out: Record<string, unknown> = {};
      let n = 0;
      for (const k of Object.keys(value).sort()) {
        if (n >= spec.maxKeys) break;
        if (!spec.key.test(k)) continue;
        const f = spec.fields !== undefined && Object.hasOwn(spec.fields, k) ? spec.fields[k]! : spec.of;
        const y = sanitize(value[k], f);
        if (y === undefined) continue;
        define(out, k, y);
        n++;
      }
      return out;
    }
  }
}

/** How a path names a key: the key itself when `shown`, else a fixed placeholder (paths never carry data). */
const keyAt = (at: string, k: string, shown: boolean): string => (shown ? `${at}.${k}` : `${at}.<key>`);

/**
 * Every place where `value` does not fit `spec`, as JSON paths ("$.overall.status", "$.dimensions[0].interval"): a
 * required field missing or undefined, a value of the wrong type, form or enum, a tuple of the wrong length, an array
 * or record over its bound, an undeclared key. A declared field's name is shown; a record key only when it matches the
 * record's own key pattern, else "<key>"; an undeclared key is always "<key>". Empty when `sanitize` keeps `value`
 * whole. Pure and synchronous.
 */
export function violations(value: unknown, spec: FieldSpec, at = "$", out: string[] = []): string[] {
  switch (spec.t) {
    case "optional": return violations(value, spec.of, at, out);
    case "variant": {
      if (!isPlainObject(value)) { out.push(at); return out; }
      const c = variantCase(value, spec);
      if (c === undefined) { out.push(`${at}.${spec.tag}`); return out; }
      return violations(value, c, at, out);
    }
    case "nullable": return value === null ? out : violations(value, spec.of, at, out);
    case "array":
      if (!Array.isArray(value)) out.push(at);
      else {
        if (value.length > spec.max) out.push(at);
        value.forEach((x, i) => violations(x, spec.of, `${at}[${i}]`, out));
      }
      return out;
    case "tuple":
      if (!Array.isArray(value) || value.length !== spec.of.length) out.push(at);
      else spec.of.forEach((f, i) => violations(value[i], f, `${at}[${i}]`, out));
      return out;
    case "object":
      if (!isPlainObject(value)) { out.push(at); return out; }
      for (const [k, f] of Object.entries(spec.fields)) {
        if (Object.hasOwn(value, k) && value[k] !== undefined) violations(value[k], f, `${at}.${k}`, out);
        else if (f.t !== "optional") out.push(`${at}.${k}`);
      }
      for (const k of Object.keys(value)) if (!Object.hasOwn(spec.fields, k)) out.push(keyAt(at, k, false));
      return out;
    case "record": {
      if (!isPlainObject(value)) { out.push(at); return out; }
      const keys = Object.keys(value).sort();
      if (keys.length > spec.maxKeys) out.push(at);
      for (const k of keys) {
        if (!spec.key.test(k)) { out.push(keyAt(at, k, false)); continue; }
        const f = spec.fields !== undefined && Object.hasOwn(spec.fields, k) ? spec.fields[k]! : spec.of;
        violations(value[k], f, keyAt(at, k, true), out);
      }
      return out;
    }
    default:
      if (sanitize(value, spec) === undefined) out.push(at);
      return out;
  }
}

/** The case a variant's tag picks, or undefined (not a plain object, no string tag, no such case). */
function variantCase(value: unknown, spec: Extract<FieldSpec, { t: "variant" }>): FieldSpec | undefined {
  if (!isPlainObject(value) || !Object.hasOwn(value, spec.tag)) return undefined;
  const tag = value[spec.tag];
  return typeof tag === "string" && Object.hasOwn(spec.cases, tag) ? spec.cases[tag] : undefined;
}

/** True when `x` has at most `decimals` decimals (always, when `decimals` is undefined): rounding to them gives `x` back. */
function hasDecimals(x: number, decimals: number | undefined): boolean {
  if (decimals === undefined) return true;
  const f = 10 ** decimals;
  return Math.round(x * f) / f === x;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** An own data property, whatever its name (assignment to "__proto__" would set the prototype instead). */
function define(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

// ---------- vocabularies: each list is checked against its type, so a new member cannot be forgotten ----------

const keysOf = <T extends string>(r: Record<T, true>): readonly T[] => Object.freeze(Object.keys(r) as T[]);

const TOOL_IDS = keysOf<ToolId>({
  "claude-code": true, codex: true, copilot: true, cursor: true, antigravity: true, "gemini-cli": true, opencode: true, cline: true,
  "roo-code": true, "kilo-code": true, windsurf: true, zed: true, kiro: true, warp: true, amp: true, goose: true, droid: true,
  "qwen-code": true, crush: true, aider: true, continue: true, "jetbrains-ai": true,
});
const WINDOWS = keysOf<Window>({ detail: true, lifetime: true });
const COVERAGE_STATUS = keysOf<CoverageEv["status"]>({ ok: true, empty: true, absent: true, drift: true, error: true, "present-undecodable": true });
const METRIC_REASONS = keysOf<NonNullable<Metric["reason"]>>({ "no-data": true, degenerate: true, "not-captured": true, "repo-signals-off": true });
const EVIDENCE_PARTS = keysOf<keyof Evidence>({
  typedTurns: true, sessions: true, days: true, weeks: true, episodes: true, editTurns: true, followUps: true, briefs: true, failingChecks: true,
  interrupts: true, workEpisodes: true, tierEpisodes: true, editEpisodesInRepo: true, landed: true, repos: true, buckets: true, bgKnown: true,
  artifacts: true, lifetimeWeeks: true, ownCommits: true,
});
/** Every `Signals` field that is a `Metric`. */
export const METRIC_KEYS = keysOf<MetricKey>({
  vae: true, closure: true, stickyMean: true, p90Run: true, actionsPerTurn: true, parallelShare: true, backgroundShare: true, fanoutPerEpisode: true,
  workflowRunsPerEpisode: true, correctionRate: true, healthyInterruptShare: true, turnsPerWork: true, queuePerTurn: true, maintainedShare: true,
  artifacts: true, briefScore: true, hygiene: true, switchesPerWeek: true, rho: true, tokensPerLanded: true, usdPerLanded: true, landedShare: true,
  reworkShare: true, prsPerWeek: true, aiCoauthoredShare: true, commitAfterSession: true, guardrails: true, headlessPerWeek: true,
  uncheckedCommandShare: true,
});
export const FEATURES = keysOf<Feature>({
  subagents: true, workflows: true, "background-agents": true, "plan-mode": true, skills: true, mcp: true, headless: true, "parallel-sessions": true,
  "model-switching": true, "manual-compaction": true,
});
export const PROMPT_ARCS = keysOf<PromptArc>({ "1": true, "2-3": true, "4-10": true, "11-30": true, "31+": true });
export const DURATION_ARCS = keysOf<DurationArc>({ "<10m": true, "10-60m": true, "1-4h": true, ">4h": true });
export const TOOLCHAINS = keysOf<Toolchain>({ js: true, py: true, go: true, rust: true, jvm: true, dotnet: true, ruby: true, php: true, swift: true, dart: true,
  native: true, shell: true, any: true });
export const EDIT_LANGS = keysOf<EditLang>({ ...Object.fromEntries(TOOLCHAINS.map((t) => [t, true])) as Record<Toolchain, true>, doc: true });
export const TECH_CATEGORIES = keysOf<TechCategory>({ data: true, infra: true, security: true, testing: true, ai: true, architecture: true, frontend: true,
  mobile: true, systems: true });
export const CONFIG_KINDS = keysOf<ConfigEv["kind"]>({ skill: true, command: true, agent: true, plugin: true, hook: true, "mcp-server": true, "memory-file": true,
  "instruction-file": true, profile: true, feature: true });
const BANDS = keysOf<Band>({ exceptional: true, strong: true, developing: true, limited: true, insufficient: true });
const FORENSIC_BANDS = keysOf<Forensics["band"]>({ consistent: true, "consistent-with-notes": true, inconsistent: true, unverifiable: true });
const CHECK_IDS = keysOf<CheckId>({ C1: true, C2: true, C3: true, C4: true, C5: true, C6: true, C7: true, C8: true, C9: true, C10: true,
  "soft:rhythm": true, "soft:repeated-long": true, "soft:recent-burst": true, "soft:unclosed-tools": true, "soft:new-config": true });
const CHECK_STATUS = keysOf<CheckStatus>({ pass: true, note: true, warn: true, fail: true, "n/a": true, info: true });
const REPO_STATUS = keysOf<RepoSignals["status"]>({ ok: true, partial: true, off: true, "git-missing": true });
const ROLES: readonly string[] = Object.freeze([...Object.values(PRACTICE_ROLES), ...Object.values(STACK_ROLES)]);

// ---------- building blocks ----------

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const oneOf = (values: readonly string[]): RegExp => new RegExp(`^(?:${values.map(esc).join("|")})$`);

/** A count: a non-negative safe integer. Every integer of the payload is one, but scores and interval ends (`SCORE`) and `activeDays`. */
const int = (s: Sensitivity = "aggregate"): FieldSpec => ({ t: "count", s });
/** A field that may be absent (its type in `Analysis` is optional). */
const opt = (of: FieldSpec): FieldSpec => ({ t: "optional", of });
const num = (s: Sensitivity = "aggregate"): FieldSpec => ({ t: "number", s });
const bool = (s: Sensitivity = "aggregate"): FieldSpec => ({ t: "boolean", s });
const en = (values: readonly string[], s: Sensitivity = "public"): FieldSpec => ({ t: "enum", values, s });
const str = (pattern: RegExp, s: Sensitivity): FieldSpec => ({ t: "string", pattern, s });
const nullable = (of: FieldSpec): FieldSpec => ({ t: "nullable", of });
const arr = (of: FieldSpec, max: number): FieldSpec => ({ t: "array", of, max });
const obj = (fields: Record<string, FieldSpec>): FieldSpec => ({ t: "object", fields });
/** A record keyed by a vocabulary. */
const counts = (keys: readonly string[], of: FieldSpec = int()): FieldSpec => ({ t: "record", key: oneOf(keys), of, maxKeys: keys.length });

/** "YYYY-MM": the only form a metric's or a coverage row's span takes. */
const MONTH = str(/^\d{4}-(?:0[1-9]|1[0-2])$/, "aggregate");
/** "YYYY-Www": an ISO week. */
const WEEK = str(/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/, "aggregate");
/** A keyed hash as the engine makes it: exactly 16 lower-case hex digits (`keyedHash`'s length). */
const KEYED_HASH = str(/^[0-9a-f]{16}$/, "pseudonymous");
const TOOL = en(TOOL_IDS);
const WINDOW = en(WINDOWS);
/** A finite number in [min, max], with at most `decimals` decimals when given. */
const bounded = (min: number, max: number, decimals?: number, s: Sensitivity = "aggregate"): FieldSpec =>
  (decimals === undefined ? { t: "bounded", min, max, s } : { t: "bounded", min, max, decimals, s });
/** A display score: an integer in [1, 99] (`displayScore` clamps to it). */
const SCORE = bounded(1, 99, 0);
/** A bootstrap interval: both ends or none (a one-point interval would claim more than the data holds), each a score. */
const INTERVAL = nullable({ t: "tuple", of: [SCORE, SCORE] });
/** A component's z: the scoring limits it to [-3, 3]. */
const Z = bounded(-3, 3);
/** A share (or a weight): a fraction in [0, 1]. */
const share = (): FieldSpec => bounded(0, 1);

/** A metric: its value (null with a reason when not measurable), sample size, window and span by month. */
const metricOf = (value: FieldSpec): FieldSpec =>
  obj({ value: nullable(value), n: int(), window: WINDOW, from: opt(MONTH), to: opt(MONTH), reason: opt(en(METRIC_REASONS)) });
const METRIC = metricOf(num());
/**
 * The metrics whose value is a share in [0, 1] (a ratio of a part to its whole, or a mean of such ratios), and the
 * one correlation in [-1, 1]; every other metric is a rate or a count per unit, unbounded above.
 */
export const SHARE_METRICS: ReadonlySet<MetricKey> = new Set<MetricKey>(["vae", "closure", "parallelShare", "backgroundShare", "correctionRate",
  "healthyInterruptShare", "maintainedShare", "briefScore", "hygiene", "landedShare", "reworkShare", "aiCoauthoredShare", "commitAfterSession",
  "guardrails"]);
const metricSpec = (k: MetricKey): FieldSpec => (SHARE_METRICS.has(k) ? metricOf(share()) : k === "rho" ? metricOf(bounded(-1, 1)) : METRIC);

/**
 * The ceiling of a forensic `ratio` (a coefficient of variation of prompt gaps): a population CV of n gaps is at most
 * sqrt(n - 1), so 1000 needs a session of about a million prompts.
 */
const RATIO_MAX = 1000;
/**
 * The spec of each kind of forensic value, with the decimals core/forensics stores it to: a share and a correlation 4,
 * a ratio 2, a count none (`VALUE_KINDS`, owned by core/forensics: `questionFor` reads the same table).
 */
export const KIND_SPECS: Readonly<Record<ValueKind, FieldSpec>> = {
  count: { t: "count", s: "aggregate" }, share: bounded(0, 1, 4), corr: bounded(-1, 1, 4), ratio: bounded(0, RATIO_MAX, 2), date: { t: "day", s: "aggregate" },
};
/** The checks whose values may hold the date: only the file-time check (C5). */
const DATED_CHECKS: ReadonlySet<CheckId> = new Set<CheckId>(["C5"]);
const valuesSpec = (dated: boolean): FieldSpec => obj(Object.fromEntries((Object.keys(VALUE_KEYS) as ValueKey[])
  .filter((k) => dated || k !== DATE_KEY).map((k) => [k, opt(KIND_SPECS[VALUE_KINDS[k]])])));
/**
 * A check, exactly `{ id, status, n, reason, tools, values }` (no English text leaves the machine: the reading side
 * rebuilds the question with `questionFor`). `reason` is one of `REASONS`; `values` is closed over `VALUE_KEYS`, each by
 * its kind; the date only on C5.
 */
const CHECK: FieldSpec = (() => {
  const VALUES = valuesSpec(false), DATED = valuesSpec(true);
  const caseOf = (id: CheckId): FieldSpec => obj({
    id: en([id]), status: en(CHECK_STATUS), n: int(), reason: en(Object.keys(REASONS) as Reason[]), tools: arr(TOOL, TOOL_IDS.length),
    values: DATED_CHECKS.has(id) ? DATED : VALUES,
  });
  return { t: "variant", tag: "id", cases: Object.fromEntries(CHECK_IDS.map((id) => [id, caseOf(id)])) };
})();

/** An MCP server's export label: a public name, or "custom #n". */
const MCP_LABEL = str(new RegExp(`^(?:${[...MCP_PUBLIC].map(esc).join("|")}|custom #[1-9]\\d{0,3})$`), "pseudonymous");
/**
 * A model's export id: exactly what `modelExportId` gives back unchanged (a known family's allowlisted id or
 * `<family>-other`), or one of its two fixed tokens, "fine-tuned" and "other". No looser shape is accepted.
 */
const MODEL_KEY: KeyTest = { test: (k) => k === "fine-tuned" || k === "other" || modelExportId(k) === k };
/** A project's opaque label: "P-" and the upper-case hex of 4, 6, 8 … or 16 digits, the shortest unique in the store. */
const PROJECT_LABEL = str(/^P-(?:[0-9A-F]{2}){2,8}$/, "pseudonymous");
/**
 * A project name the person chose to reveal, in any script: letters, combining marks, digits, spaces and ". _ -", and
 * the zero-width non-joiner and joiner (U+200C, U+200D) that some scripts write words with; 1 to 64 code points. It
 * starts with a letter or digit and ends with a letter, mark or digit (no edge space or joiner). No path separator,
 * control or format character other than the two joiners, or markup character can appear.
 */
const REVEALED_NAME = str(/^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N} ._\u200C\u200D-]{0,62}[\p{L}\p{M}\p{N}])?$/u, "revealed");

/**
 * The `aiprof/2` payload: every field the export may hold, with its type and sensitivity class (spec §6.7, Task 14's
 * tables). Whatever it does not declare never leaves the machine.
 */
export const AIPROF2: FieldSpec = obj({
  schema: en(["aiprof/2"]),
  core: str(/^(?=.{1,64}$)(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/, "public"),
  reference: en(["v0"]),
  /** The repo pass's status: a reader must see a pass that was partial or off. */
  repoSignals: en(REPO_STATUS),
  coverage: arr(obj({
    tool: TOOL, window: WINDOW, statuses: arr(en(COVERAGE_STATUS), 64), beta: bool("public"), from: opt(MONTH), to: opt(MONTH),
    sessions: int(), prompts: int(), formatChanged: bool(),
  }), 64),
  overall: obj({
    status: en(["scored", "insufficient"]), score: nullable(SCORE), interval: INTERVAL, band: en(BANDS),
    coverage: str(/^[0-7]\/7$/, "aggregate"),
  }),
  dimensions: arr(obj({
    id: en(DIMENSION_IDS), status: en(["scored", "insufficient", "not-measurable", "not-measured"]), score: nullable(SCORE), interval: INTERVAL,
    openTail: bool(), confidence: nullable(en(["low", "medium", "high"])), n: int(), needs: int(), part: en(EVIDENCE_PARTS), window: WINDOW,
    components: arr(obj({
      id: en(COMPONENTS.map((c) => c.id)), status: en(["ok", "not-measurable", "not-measured"]), x: nullable(num()), z: nullable(Z), n: int(),
      weight: share(), window: WINDOW,
    }), 16),
  }), DIMENSION_IDS.length),
  personas: arr(en(ROLES), 3),
  signals: obj(Object.fromEntries(METRIC_KEYS.map((k) => [k, metricSpec(k)]))),
  exposure: obj({
    tenureWeeks: METRIC,
    activeWeeks: obj({ detail: METRIC, lifetime: METRIC }),
    weekly: arr(obj({ week: WEEK, activeDays: bounded(0, 7, 0), detailPrompts: int(), lifetimePrompts: int() }), 52),
    tools: arr(obj({ tool: TOOL, window: WINDOW, sessions: int(), prompts: int(), actions: int(), from: opt(MONTH), to: opt(MONTH) }), 64),
    rotation: obj({ active90d: arr(TOOL, TOOL_IDS.length), ever: arr(TOOL, TOOL_IDS.length) }),
    arcs: obj({
      prompts: obj(Object.fromEntries(PROMPT_ARCS.map((k) => [k, int()]))), medianPrompts: nullable(num()),
      durations: obj(Object.fromEntries(DURATION_ARCS.map((k) => [k, int()]))),
    }),
    firstSeen: counts(FEATURES, WEEK),
    models: { t: "record", key: MODEL_KEY, of: int(), maxKeys: 64 },
  }),
  /** The stack, with the window and n of its edit counts (`Stack.meta`). */
  stack: obj({ languages: counts(EDIT_LANGS), toolchains: counts(TOOLCHAINS), techCategories: counts(TECH_CATEGORIES), window: WINDOW, n: int() }),
  /** The risk posture, with its window and n (the sessions that gave a mode). */
  risk: obj({
    permission: counts([...RISK_TOKENS.permission, "other"]), approval: counts([...RISK_TOKENS.approval, "other"]),
    sandbox: counts([...RISK_TOKENS.sandbox, "other"]), window: WINDOW, n: int(),
  }),
  config: obj({
    byKind: counts(CONFIG_KINDS, obj({ authored: int(), installed: int(), other: int(), used: int() })),
    hooksDisabled: bool(), memoryFiles: int(), mcpServers: arr(MCP_LABEL, 256),
  }),
  projects: arr(obj({
    label: PROJECT_LABEL, name: opt(REVEALED_NAME), sessions: int(), activeWeeks: int(), tools: arr(TOOL, TOOL_IDS.length),
    inRepo: bool(), lastWeek: opt(WEEK),
  }), 100),
  otherProjects: obj({ projects: int(), sessions: int() }),
  forensics: obj({
    band: en(FORENSIC_BANDS), serverBacked: nullable(share()), anchorable: arr(TOOL, TOOL_IDS.length), notAnchorable: arr(TOOL, TOOL_IDS.length),
    checks: arr(CHECK, 32),
  }),
  identity: obj({ accounts: int(), bindings: arr(KEYED_HASH, 64) }),
  /** What the exclusions left out: tool, project and session counts, whether a date range was given, and the active weeks outside it (no dates). */
  /**
   * What the builder left out, never silently: entries a cap cut from a list (`coverage`, `weeks`, `tools`,
   * `mcpServers`, `bindings`), the summed counts under keys outside a vocabulary (`promptArcs`, `durationArcs`,
   * `languages`, `toolchains`, `techCategories`; `configKinds` = config entries of an unknown kind), and the first-seen
   * features outside `FEATURES` (`features`).
   */
  omitted: obj(Object.fromEntries(["coverage", "weeks", "tools", "mcpServers", "bindings", "promptArcs", "durationArcs", "languages", "toolchains",
    "techCategories", "configKinds", "features"].map((k) => [k, int()]))),
  exclusions: obj({ tools: int(), projects: int(), sessions: int(), dateRange: bool(), weeksOutside: int() }),
});
