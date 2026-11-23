import pkg from "../package.json" with { type: "json" };
import { exposure, type Exposure } from "./analysis/exposure";
import { projectLabels, projects, type ProjectSummary } from "./analysis/labels";
import { panels, type ConfigPanel, type CoveragePanel, type DayParts, type RiskPosture, type Stack } from "./analysis/panels";
import { buildSessionTable } from "./analysis/sessions";
import { buildSessionStats } from "./analysis/walk";
import { runForensics, type Forensics, type ReleaseTable } from "./forensics/index";
import type { RepoSignals } from "./git/types";
import type { ConfigEv, Ev } from "./model/events";
import type { ToolId } from "./model/ids";
import type { ScanResult, Warning } from "./scan";
import { bootstrap, DEFAULT_B, DEFAULT_SEED } from "./scoring/bootstrap";
import { overall, type Overall } from "./scoring/overall";
import { loadReference } from "./scoring/reference";
import { roles } from "./scoring/roles";
import { scoreDimensions, type DimensionResult } from "./scoring/score";
import { computeSignals } from "./signals/compute";
import { computeGlobals } from "./signals/globals";
import type { Signals } from "./signals/types";

/**
 * How to analyze. `reference`: the reference table (v0, the only one); `bootstrap` and `seed`: the bootstrap's replicate
 * count (default 200) and seed (default 0x5eed); `now`: the analysis time (default `raw.finishedAt`, never the clock);
 * `timeZone`: the IANA zone days and weeks are keyed in (default the process zone, read through `Intl`); `exclude`:
 * tools, projects (opaque labels or projectKeys), and a date range (epoch ms, inclusive) to leave out; `releases`: the
 * release table C9 checks against (default the shipped one).
 */
export interface AnalyzeOptions { reference?: "v0"; bootstrap?: number; seed?: number; now?: number; timeZone?: string;
  exclude?: { tools?: ToolId[]; projects?: string[]; from?: number; to?: number }; releases?: ReleaseTable }

/**
 * The complete analysis of a scan result: plain JSON data (no Map, Set, class instance or function) holding only finite
 * numbers. Nothing outside `private` holds free text: projects are keyed hashes with opaque labels, and raw config
 * names and model ids sit only under `private`, which exports read through allowlists only.
 * - `meta`: the core version and the options in force; `repoSignals` is the scan's repo-signal status.
 * - `dimensions` carry the bootstrap's intervals; `overall` its interval; `personas` = `roles(dimensions, stack)`.
 * - `forensics` is display only: it never changes a score, an evidence minimum or a confidence.
 * - `identity`: the distinct `IdentityEv` hashes of kept tools (sorted) and their count.
 * - `exclusions`: the tools and projects the exclusions hit, and the sessions they dropped.
 * - `diagnostics`: orphan events per kind, what the cross-tool dedupe found, and the scan's warnings.
 */
export interface Analysis {
  meta: { core: string; reference: "v0"; bootstrap: number; seed: number; now: number; timeZone: string; repoSignals: RepoSignals["status"] };
  coverage: CoveragePanel; signals: Signals; dimensions: DimensionResult[]; overall: Overall; personas: string[];
  exposure: Exposure; stack: Stack; risk: RiskPosture; config: ConfigPanel; projects: ProjectSummary[]; forensics: Forensics;
  identity: { accounts: number; hashes: string[] }; exclusions: { tools: number; projects: number; sessions: number };
  diagnostics: { orphans: Partial<Record<Ev["k"], number>>; dedupe: { hostSessions: number; pairedPrompts: number; relabelled: number }; warnings: Warning[] };
  private: { dayParts: DayParts; config: Array<{ kind: ConfigEv["kind"]; name: string; key: string; provenance: ConfigEv["provenance"]; used: boolean }>;
    models: Record<string, number> };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The analysis of a scan result (see `Analysis`): pure, synchronous and deterministic. No I/O and no clock: `now`
 * defaults to `raw.finishedAt`, and all randomness is the seeded bootstrap's. The order of work is fixed: labels and the
 * project exclusions, the session table, the per-session statistics, the globals, the signals, the dimensions, the
 * bootstrap (over the same statistics and globals as the point estimate), the overall, exposure and the panels, the
 * projects, the personas, forensics and identity. `now` must be finite; an unknown zone is a RangeError from `Intl`.
 */
export function analyze(raw: ScanResult, o: AnalyzeOptions = {}): Analysis {
  const reference = o.reference ?? "v0";
  const B = o.bootstrap ?? DEFAULT_B;
  const seed = o.seed ?? DEFAULT_SEED;
  const now = o.now ?? raw.finishedAt;
  if (!Number.isFinite(now)) throw new RangeError("analyze: now must be a finite epoch-ms time");
  const timeZone = o.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ref = loadReference(reference);

  // labels over every project of the store, so a label names the same project whatever is excluded
  const keys: string[] = [];
  for (const s of raw.store.all("session")) if (s.projectKey !== undefined) keys.push(s.projectKey);
  const labels = projectLabels(raw.salt, keys);
  const keyOf = new Map<string, string>();
  for (const [key, label] of labels) keyOf.set(label, key);
  const ex = o.exclude ?? {};
  const exclude = { ...ex, ...(ex.projects ? { projects: ex.projects.map((p) => keyOf.get(p) ?? keyOf.get(p.toUpperCase()) ?? p) } : {}) };

  const t = buildSessionTable(raw, { now, timeZone, exclude });
  const stats = buildSessionStats(t, raw.store, raw.repos, { timeZone });
  const g = computeGlobals(t, stats, raw, { now });
  const signals = computeSignals(stats, g);
  const dimensions = scoreDimensions(signals, ref);
  const boot = bootstrap(stats, g, ref, overall(dimensions, null).included, { B, seed });
  for (const d of dimensions) d.interval = boot.intervals[d.id] ?? null;
  const total = overall(dimensions, boot.overall);
  const exp = exposure(t, raw, { now, timeZone, ...(g.firstParallelBucket === undefined ? {} : { firstParallelBucket: g.firstParallelBucket }) });
  const p = panels(t, raw, { timeZone });
  const projectList = projects(t, labels);
  const personas = roles(dimensions, p.stack);
  const forensics = runForensics(raw, t, stats, { now, timeZone, ...(o.releases ? { releases: o.releases } : {}) });
  const hashes = new Set<string>();
  for (const e of raw.store.all("identity")) if (!t.scope.tools.has(e.tool)) hashes.add(e.hash);

  return {
    meta: { core: pkg.version, reference, bootstrap: boot.B, seed, now, timeZone, repoSignals: raw.repos.status },
    coverage: p.coverage, signals, dimensions, overall: total, personas,
    exposure: exp, stack: p.stack, risk: p.risk, config: p.config, projects: projectList, forensics,
    identity: { accounts: hashes.size, hashes: [...hashes].sort(cmp) },
    exclusions: { ...t.exclusions },
    diagnostics: { orphans: { ...t.orphans }, dedupe: { ...t.dedupe }, warnings: raw.warnings.map((w) => ({ ...w })) },
    private: { dayParts: p.dayParts, config: p.privateConfig, models: p.privateModels },
  };
}
