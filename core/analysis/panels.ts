import type { ConfigEv, CoverageEv, ToolEv } from "../model/events";
import type { TechCategory, Toolchain, ToolId, Window } from "../model/ids";
import type { ScanResult } from "../scan";
import { Span } from "../signals/types";
import { keyedHash } from "../text/hash";
import { langOfExt, type EditLang } from "../text/langs";
import { analysisScope, artifactUse } from "./artifacts";
import { humanInScope } from "./exposure";
import { promptWindowByTool } from "./promptwindow";
import type { MetricMeta, SessionTable } from "./types";
import { isAction } from "./walk";

export type StackRole = "frontend" | "backend" | "mobile" | "data";

/**
 * The agent-touched stack (relabelled, not "knowledge", spec §6.5). `languages`: detail edit and write actions with an
 * extension, by `langOfExt` (`doc` included); `toolchains`: check actions by their toolchain (none when unknown);
 * `techCategories`: `PromptFeatures.techCats` summed over the human prompts in scope of each tool's prompt window
 * (`promptWindowByTool`); `roleEdits`: code edits (no `doc`) per stack role, by `editExt` (pre-flight P12). `meta`
 * describes the edit actions: window `detail`, their sources and span, `n` = the edit actions counted.
 */
export interface Stack { languages: Partial<Record<EditLang, number>>; toolchains: Partial<Record<Toolchain, number>>;
  techCategories: Partial<Record<TechCategory, number>>; roleEdits: Partial<Record<StackRole, number>>; meta: MetricMeta }
/**
 * Risk posture, over the detail-window top-level sessions (`t.detailTop`): `permission` = sessions per
 * `permission-mode` detail (a session counts once per mode it used); `approval` and `sandbox` = sessions per value.
 * `meta.n`: the sessions that gave any of them.
 */
export interface RiskPosture { permission: Record<string, number>; approval: Record<string, number>; sandbox: Record<string, number>; meta: MetricMeta }
/**
 * Config, by artifact kind: the distinct (kind, name) entries of kept tools by winning provenance (`authored`,
 * `installed`, else `other`), and how many are in use (`artifactUse`, the rule globals scores). `hooksDisabled`: a
 * `hooks-disabled` feature entry; `memoryFiles`: memory-file entries (shown, never scored: the agent writes them).
 */
export interface ConfigPanel { byKind: Partial<Record<ConfigEv["kind"], { authored: number; installed: number; other: number; used: number }>>;
  hooksDisabled: boolean; memoryFiles: number }
/**
 * What was read, per tool and window of kept tools (sorted): each source once (sorted) with its status — the first of
 * error, drift, present-undecodable, ok, empty, absent among its candidates — and beta flag; `from`/`to` span the
 * coverage's; `sessions` = top-level kept rows of that tool and window, `prompts` = its human prompts in scope;
 * `formatChanged` when any source drifted.
 */
export interface CoveragePanel { rows: Array<{ tool: ToolId; window: Window; sources: Array<{ source: string; status: CoverageEv["status"]; beta: boolean }>;
  from?: number; to?: number; sessions: number; prompts: number; formatChanged: boolean }> }
/** Human prompts in scope of each tool's prompt window, by local hour: [0, 6), [6, 12), [12, 18), [18, 24). */
export interface DayParts { night: number; morning: number; afternoon: number; evening: number }

/**
 * Everything `panels` returns. `privateConfig` and `privateModels` hold raw names (config names, model ids) and belong
 * to `analysis.private` only: `privateConfig` = every `artifactUse` record with `key` = keyedHash(raw.salt, name)
 * (pre-flight P15); `privateModels` = raw model id → top-level kept sessions whose models name it (pre-flight P13).
 */
export interface Panels { stack: Stack; risk: RiskPosture; config: ConfigPanel; coverage: CoveragePanel; dayParts: DayParts;
  privateConfig: Array<{ kind: ConfigEv["kind"]; name: string; key: string; provenance: ConfigEv["provenance"]; used: boolean }>;
  privateModels: Record<string, number> }

/** Stack roles by extension, matched first (pre-flight P12). */
const ROLE_EXT: ReadonlyMap<string, StackRole> = new Map<string, StackRole>([
  ...["tsx", "jsx", "vue", "svelte", "css", "scss", "html"].map((e) => [e, "frontend"] as const),
  ...["swift", "kt", "dart"].map((e) => [e, "mobile"] as const),
  ...["sql", "ipynb"].map((e) => [e, "data"] as const),
]);
/** Backend takes the remaining code edits of these languages. */
const BACKEND_LANGS: ReadonlySet<EditLang> = new Set<EditLang>(["py", "go", "rust", "jvm", "dotnet", "ruby", "php", "js"]);
/** Which status a source shows when its candidates differ: the first in this list. */
const STATUS_ORDER: readonly CoverageEv["status"][] = ["error", "drift", "present-undecodable", "ok", "empty", "absent"];

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const bump = <K extends string>(h: Partial<Record<K, number>>, k: K, by = 1): void => { h[k] = (h[k] ?? 0) + by; };

/** The stack role of a code edit's extension: Frontend, Mobile and Data by extension first, then Backend by language. */
export function stackRoleOf(ext: string | undefined): StackRole | undefined {
  if (!ext) return undefined;
  const e = ext.toLowerCase();
  const byExt = ROLE_EXT.get(e);
  if (byExt !== undefined) return byExt;
  const lang = langOfExt(e);
  return lang !== undefined && BACKEND_LANGS.has(lang) ? "backend" : undefined;
}

/** One formatter per zone: the local hour (0–23) of an epoch-ms time. */
const HOUR_FORMATS = new Map<string, Intl.DateTimeFormat>();
function localHour(ms: number, timeZone: string): number {
  let f = HOUR_FORMATS.get(timeZone);
  if (!f) HOUR_FORMATS.set(timeZone, (f = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" })));
  return Number(f.format(ms)) % 24;
}

/** The unscored panels (spec §6.5): pure and synchronous, with an explicit time zone. */
export function panels(t: SessionTable, raw: ScanResult, o: { timeZone: string }): Panels {
  const scope = analysisScope(raw, t);
  const { inRange, excluded, detailRows } = scope;
  const human = humanInScope(raw, t);
  const windowOf = promptWindowByTool(raw, t);

  // stack: edits and checks of kept detail rows, inside the range
  const languages: Stack["languages"] = {};
  const toolchains: Stack["toolchains"] = {};
  const roleEdits: Stack["roleEdits"] = {};
  const editSpan = new Span();
  let edits = 0;
  for (const r of detailRows) {
    for (const e of raw.store.forSession(r.id, "tool")) {
      if (!inRange(e.ts) || !isAction(e)) continue;
      if (e.checks !== undefined && e.checks.length > 0 && e.toolchain !== undefined) bump(toolchains, e.toolchain);
      if (!isEdit(e)) continue;
      const lang = langOfExt(e.editExt)!;
      edits++;
      bump(languages, lang);
      editSpan.addSource(e.source);
      editSpan.addTs(e.ts);
      if (lang === "doc") continue;
      const role = stackRoleOf(e.editExt);
      if (role !== undefined) bump(roleEdits, role);
    }
  }

  // tech categories and day parts: human prompts of each tool's prompt window
  const techCategories: Stack["techCategories"] = {};
  const dayParts: DayParts = { night: 0, morning: 0, afternoon: 0, evening: 0 };
  const promptsOf = new Map<string, number>(); // tool \0 window → human prompts in scope (coverage rows)
  for (const p of raw.store.all("prompt")) {
    if (!human(p)) continue;
    const key = `${p.tool}\u0000${p.window}`;
    promptsOf.set(key, (promptsOf.get(key) ?? 0) + 1);
    if (windowOf.get(p.tool) !== p.window) continue;
    for (const [cat, n] of Object.entries(p.features.techCats) as [TechCategory, number][]) if (Number.isFinite(n) && n > 0) bump(techCategories, cat, n);
    const h = localHour(p.ts, o.timeZone);
    dayParts[h < 6 ? "night" : h < 12 ? "morning" : h < 18 ? "afternoon" : "evening"]++;
  }

  // risk posture
  const permission: Record<string, number> = {};
  const approval: Record<string, number> = {};
  const sandbox: Record<string, number> = {};
  const riskSpan = new Span();
  let riskRows = 0;
  for (const r of t.detailTop) {
    const modes = new Set<string>();
    for (const m of raw.store.forSession(r.id, "marker")) {
      if (m.kind === "permission-mode" && m.detail !== undefined && inRange(m.ts) && scope.detailSources.has(m.source)) { modes.add(m.detail); riskSpan.addSource(m.source); }
    }
    for (const mode of modes) bump(permission, mode);
    if (r.approval !== undefined) bump(approval, r.approval);
    if (r.sandbox !== undefined) bump(sandbox, r.sandbox);
    if (modes.size === 0 && r.approval === undefined && r.sandbox === undefined) continue;
    riskRows++;
    riskSpan.add({ source: r.source, start: Math.max(r.start, t.scope.from), end: Math.min(r.end, t.scope.to) });
  }

  // config
  const uses = artifactUse(raw, t, scope);
  const byKind: ConfigPanel["byKind"] = {};
  for (const u of uses) {
    const k = (byKind[u.kind] ??= { authored: 0, installed: 0, other: 0, used: 0 });
    k[u.provenance === "authored" ? "authored" : u.provenance === "installed" ? "installed" : "other"]++;
    if (u.used) k.used++;
  }
  const config: ConfigPanel = {
    byKind,
    hooksDisabled: scope.configs.some((c) => c.kind === "feature" && c.name === "hooks-disabled"),
    memoryFiles: scope.configs.filter((c) => c.kind === "memory-file").length,
  };
  const privateConfig: Panels["privateConfig"] = uses.map((u) => ({ kind: u.kind, name: u.name, key: keyedHash(raw.salt, u.name), provenance: u.provenance, used: u.used }));

  // coverage, sessions and models
  const sessionsOf = new Map<string, number>();
  const privateModels: Record<string, number> = {};
  for (const r of t.rows.values()) {
    if (r.parentId !== undefined || t.hosts.has(r.id)) continue;
    const key = `${r.tool}\u0000${r.window}`;
    sessionsOf.set(key, (sessionsOf.get(key) ?? 0) + 1);
    for (const m of new Set(r.models)) privateModels[m] = (privateModels[m] ?? 0) + 1;
  }
  const groups = new Map<string, CoverageEv[]>();
  for (const c of raw.coverage) {
    if (excluded.has(c.tool)) continue;
    const key = `${c.tool}\u0000${c.window}`;
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }
  const rows: CoveragePanel["rows"] = [...groups.keys()].sort(cmp).map((key) => {
    const list = groups.get(key)!;
    const bySource = new Map<string, { status: CoverageEv["status"]; beta: boolean }>();
    let from = Infinity;
    let to = -Infinity;
    for (const c of list) {
      const was = bySource.get(c.source);
      if (!was) bySource.set(c.source, { status: c.status, beta: c.beta });
      else { was.beta ||= c.beta; if (STATUS_ORDER.indexOf(c.status) < STATUS_ORDER.indexOf(was.status)) was.status = c.status; }
      if (c.from !== undefined && Number.isFinite(c.from) && c.from < from) from = c.from;
      if (c.to !== undefined && Number.isFinite(c.to) && c.to > to) to = c.to;
    }
    const [tool, window] = key.split("\u0000") as [ToolId, Window];
    return {
      tool, window, sources: [...bySource.keys()].sort(cmp).map((source) => ({ source, ...bySource.get(source)! })),
      ...(Number.isFinite(from) ? { from } : {}), ...(Number.isFinite(to) ? { to } : {}),
      sessions: sessionsOf.get(key) ?? 0, prompts: promptsOf.get(key) ?? 0, formatChanged: list.some((c) => c.status === "drift"),
    };
  });

  return {
    stack: { languages, toolchains, techCategories, roleEdits, meta: metaOf(editSpan, edits) },
    risk: { permission, approval, sandbox, meta: metaOf(riskSpan, riskRows) },
    config, coverage: { rows }, dayParts, privateConfig, privateModels,
  };
}

/** A detail-window span's metadata: its sorted sources and range, and `n`. */
function metaOf(span: Span, n: number): MetricMeta {
  const { value: _value, reason: _reason, ...meta } = span.metric("detail", n, null);
  return meta;
}

/** An edit or write action with an extension. */
const isEdit = (e: ToolEv): boolean => (e.category === "edit" || e.category === "write") && langOfExt(e.editExt) !== undefined;
