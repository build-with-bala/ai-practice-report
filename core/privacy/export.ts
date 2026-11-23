import { dayKey, isoWeek } from "../analysis/activity";
import type { Metric } from "../analysis/types";
import type { Analysis } from "../analyze";
import type { CoverageEv } from "../model/events";
import { mcpLabels, modelExportId, riskExportToken, RISK_TOKENS } from "./allowlists";
import { canonicalJson } from "./jcs";
import { AIPROF2, METRIC_KEYS, sanitize } from "./schema";

/**
 * How to export. `schema`: the payload schema (`aiprof/2`, the only one). `reveal`: projects the person chose to name,
 * by label (matched without regard to letter case); every other project stays a label.
 */
export interface ExportOptions { schema: "aiprof/2"; reveal?: Array<{ label: string; name: string }> }
/** The export: `value` is the payload, `json` its canonical bytes (RFC 8785), `bytes` their UTF-8 length; `JSON.parse(json)` deep-equals `value` (the preview contract). */
export interface ExportResult { schema: "aiprof/2"; value: unknown; json: string; bytes: number }

/** At most this many projects are exported, by sessions; the rest are counted in `otherProjects`. */
const MAX_PROJECTS = 100;
/** Exported weeks of the weekly activity: the latest 52. */
const MAX_WEEKS = 52;
/** Fractions are exported to this many decimals (pre-flight P22), so the bytes never depend on a platform's last bit. */
const DECIMALS = 4;
/** Coverage statuses, worst first: a row shows the first its sources hold (the panel's own order). */
const STATUS_ORDER: readonly CoverageEv["status"][] = ["error", "drift", "present-undecodable", "ok", "empty", "absent"];

const round = (x: number): number => {
  const f = 10 ** DECIMALS;
  return Math.round(x * f) / f;
};
const roundOrNull = (x: number | null): number | null => (x === null || !Number.isFinite(x) ? null : round(x));
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Plain data keyed by arbitrary strings, without a prototype a key could reach. */
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

/**
 * The `aiprof/2` export of an analysis: the only payload that may leave the machine (spec §6.7). It maps the analysis
 * to the payload's form (spans by month, first-seen times by ISO week, raw channels through the allowlists, fractions
 * rounded to 4 decimals), then keeps only what `AIPROF2` declares (deny by default), and serializes that canonically.
 * `private` and `diagnostics` are never read, but for the allowlisted model ids and MCP labels. Pure and synchronous.
 */
export function exportPayload(a: Analysis, o: ExportOptions): ExportResult {
  if (o.schema !== "aiprof/2") throw new RangeError("exportPayload: the only schema is aiprof/2");
  const tz = a.meta.timeZone;
  const month = (ms: number | undefined): string | undefined => (ms === undefined || !Number.isFinite(ms) ? undefined : dayKey(ms, tz).slice(0, 7));
  const week = (ms: number): string | undefined => (Number.isFinite(ms) ? isoWeek(dayKey(ms, tz)) : undefined);
  const metric = (m: Metric): Record<string, unknown> => ({
    value: roundOrNull(m.value), n: m.n, window: m.window, from: month(m.from), to: month(m.to), reason: m.reason,
  });

  const reveal = new Map<string, string>();
  for (const r of o.reveal ?? []) reveal.set(r.label.toUpperCase(), r.name);

  const models = dict<number>();
  for (const [raw, n] of Object.entries(a.private.models)) {
    if (typeof n !== "number" || !Number.isFinite(n)) continue;
    const id = modelExportId(raw);
    models[id] = (models[id] ?? 0) + n;
  }

  const risk = (kind: keyof typeof RISK_TOKENS, h: Record<string, number>): Record<string, number> => {
    const out = dict<number>();
    for (const [raw, n] of Object.entries(h)) {
      if (typeof n !== "number" || !Number.isFinite(n)) continue;
      const k = riskExportToken(kind, raw);
      out[k] = (out[k] ?? 0) + n;
    }
    return out;
  };

  const labels = [...new Set(mcpLabels(a.private.config).values())];
  const custom = (l: string): number => (l.startsWith("custom #") ? Number(l.slice("custom #".length)) : 0);
  const mcpServers = labels.sort((x, y) => custom(x) - custom(y) || cmp(x, y)); // public names first, then custom #1, #2, …

  const shown = a.projects.slice(0, MAX_PROJECTS);
  const rest = a.projects.slice(MAX_PROJECTS);

  const firstSeen = dict<string | undefined>();
  for (const [f, ms] of Object.entries(a.exposure.firstSeen)) if (typeof ms === "number") firstSeen[f] = week(ms);

  const draft = {
    schema: "aiprof/2",
    core: a.meta.core,
    reference: a.meta.reference,
    coverage: a.coverage.rows.map((r) => ({
      tool: r.tool, window: r.window,
      status: STATUS_ORDER.find((s) => r.sources.some((x) => x.status === s)) ?? "absent",
      beta: r.sources.some((x) => x.beta), from: month(r.from), to: month(r.to), sessions: r.sessions, prompts: r.prompts, formatChanged: r.formatChanged,
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
      tools: a.exposure.tools.map((t) => ({ tool: t.tool, window: t.window, sessions: t.sessions, prompts: t.prompts, actions: t.actions, from: month(t.from), to: month(t.to) })),
      rotation: a.exposure.rotation,
      arcs: { prompts: a.exposure.arcs.prompts, medianPrompts: roundOrNull(a.exposure.arcs.medianPrompts), durations: a.exposure.arcs.durations },
      firstSeen,
      models,
    },
    stack: { languages: a.stack.languages, toolchains: a.stack.toolchains, techCategories: a.stack.techCategories },
    risk: { permission: risk("permission", a.risk.permission), approval: risk("approval", a.risk.approval), sandbox: risk("sandbox", a.risk.sandbox) },
    config: { byKind: a.config.byKind, hooksDisabled: a.config.hooksDisabled, memoryFiles: a.config.memoryFiles, mcpServers },
    projects: shown.map((p) => ({
      label: p.label, name: reveal.get(p.label.toUpperCase()), sessions: p.sessions, activeWeeks: p.activeWeeks, tools: p.tools, inRepo: p.inRepo,
      lastWeek: p.lastWeek,
    })),
    otherProjects: { projects: rest.length, sessions: rest.reduce((s, p) => s + p.sessions, 0) },
    forensics: {
      band: a.forensics.band, serverBacked: roundOrNull(a.forensics.serverBacked), anchorable: a.forensics.anchorable, notAnchorable: a.forensics.notAnchorable,
      checks: a.forensics.checks.map((c) => ({ id: c.id, status: c.status, reason: c.reason, values: roundValues(c.values), askAbout: c.askAbout })),
    },
    identity: { accounts: a.identity.accounts, bindings: a.identity.hashes },
    exclusions: { tools: a.exclusions.tools, projects: a.exclusions.projects, sessions: a.exclusions.sessions },
  };

  const value = sanitize(draft, AIPROF2);
  const json = canonicalJson(value);
  return { schema: "aiprof/2", value, json, bytes: new TextEncoder().encode(json).length };
}

/** A check's values with numbers rounded; anything else as it is (the schema decides what stays). */
function roundValues(values: Record<string, unknown>): Record<string, unknown> {
  const out = dict<unknown>();
  for (const [k, v] of Object.entries(values)) out[k] = typeof v === "number" && Number.isFinite(v) ? round(v) : v;
  return out;
}

