import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { detectEnv, type Env } from "./env/env";
import { homesToScan } from "./env/paths";
import { installSignalCleanup, TempRegistry } from "./io/temp";
import type { CoverageEv, Ev } from "./model/events";
import type { ToolId } from "./model/ids";
import { EventStore } from "./model/store";
import { registry } from "./sources/registry";
import type { Candidate, ScanCtx, SourcePlugin, TempDirs } from "./sources/types";
import { keyedHash, normalizePath } from "./text/hash";

export interface ScanOptions { env?: Env; plugins?: SourcePlugin[]; tools?: ToolId[]; since?: number; wsl?: boolean; salt?: Uint8Array;
  concurrency?: number; onProgress?: (p: { plugin: string; done: number; total: number }) => void; signal?: AbortSignal;
  onLog?: (level: "debug" | "info" | "warn", code: string, n?: number) => void;
  /** @internal test hook: replace the per-scan temp registry. */
  tempFactory?: (base: string) => TempDirs }
export interface Warning { code: "drift" | "error" | "too-large" | "temp-leftover" | "beta"; tool: ToolId | "scan"; source: string; detail: string }
export interface ScanResult { store: EventStore; coverage: CoverageEv[]; warnings: Warning[]; cwds: Map<string, string>;
  salt: Uint8Array; startedAt: number; finishedAt: number; tempClean: boolean }

/** Coverage the orchestrator writes for a plugin (absent, error, aborted), in the window the plugin reports. */
function emptyCoverage(p: SourcePlugin, status: CoverageEv["status"], note?: string): CoverageEv {
  const ev: CoverageEv = { k: "coverage", tool: p.tool, source: p.id, window: p.window ?? "detail", status, beta: p.beta,
    files: 0, bytes: 0, records: 0, skipped: {}, unknownTypes: {}, versions: [] };
  if (note !== undefined) ev.note = note;
  return ev;
}

export async function scan(opts: ScanOptions = {}): Promise<ScanResult> {
  const startedAt = Date.now();
  const env = opts.env ?? detectEnv();
  const salt = opts.salt ?? new Uint8Array(randomBytes(32));
  const homes = homesToScan(env, opts.wsl ?? false);
  const plugins = (opts.plugins ?? registry).filter((p) => !opts.tools || opts.tools.includes(p.tool));
  const store = new EventStore();
  const warnings: Warning[] = [];
  const cwds = new Map<string, string>();
  const nonCoverage = new Map<SourcePlugin, number>();
  const now = Date.now();
  const signal = opts.signal ?? new AbortController().signal;

  const base = mkdtempSync(path.join(env.tmp, "aipr-scan-"));
  const temp = opts.tempFactory?.(base) ?? new TempRegistry(base);
  const uninstall = installSignalCleanup(temp);
  let tempClean = false;

  try {
    const aborted = new Set<SourcePlugin>();
    const jobs: { plugin: SourcePlugin; cand: Candidate }[] = [];
    for (const plugin of plugins) {
      if (signal.aborted) { aborted.add(plugin); continue; }
      let cands: Candidate[] = [];
      try {
        cands = plugin.locate(env, homes);
      } catch (e) {
        const name = (e as Error)?.constructor?.name ?? "Error";
        store.add(emptyCoverage(plugin, "error", name));
        warnings.push({ code: "error", tool: plugin.tool, source: plugin.id, detail: name });
        continue;
      }
      if (cands.length === 0) store.add(emptyCoverage(plugin, "absent"));
      for (const cand of cands) jobs.push({ plugin, cand });
    }

    const total = jobs.length;
    let done = 0;
    let next = 0;
    const started = new Set<number>();
    const safe = (f: () => void) => { try { f(); } catch { /* caller callbacks never fail a scan */ } };
    const runJob = async ({ plugin, cand }: { plugin: SourcePlugin; cand: Candidate }): Promise<void> => {
      const ctx: ScanCtx = {
        env, now, since: opts.since, salt, temp, signal,
        emit: (e: Ev) => { if (e.k !== "coverage") nonCoverage.set(plugin, (nonCoverage.get(plugin) ?? 0) + 1); store.add(e); },
        hash: (v) => keyedHash(salt, v),
        registerCwd: (cwd) => {
          const key = keyedHash(salt, normalizePath(cwd));
          if (!cwds.has(key)) cwds.set(key, cwd);
          return key;
        },
        log: (level, code, n) => safe(() => opts.onLog?.(level, code, n)),
      };
      try {
        await plugin.scan(cand, ctx);
      } catch (e) {
        const name = (e as Error)?.constructor?.name ?? "Error";
        store.add(emptyCoverage(plugin, "error", name));
        warnings.push({ code: "error", tool: plugin.tool, source: plugin.id, detail: name });
      }
      done++;
      safe(() => opts.onProgress?.({ plugin: plugin.id, done, total }));
    };
    const worker = async () => {
      while (!signal.aborted && next < jobs.length) {
        const i = next++;
        started.add(i);
        try { await runJob(jobs[i]!); } catch { /* runJob should not throw; never reject a worker */ }
      }
    };
    const n = Math.max(1, Math.min(opts.concurrency ?? 4, jobs.length));
    await Promise.allSettled(Array.from({ length: n }, worker));

    jobs.forEach((j, i) => { if (!started.has(i)) aborted.add(j.plugin); });
    for (const plugin of aborted) store.add(emptyCoverage(plugin, "error", "aborted"));
    if (aborted.size > 0) warnings.push({ code: "error", tool: "scan", source: "scan", detail: "aborted" });

    for (const [plugin, count] of nonCoverage) {
      if (plugin.beta && count > 0) warnings.push({ code: "beta", tool: plugin.tool, source: plugin.id, detail: "beta reader" });
    }
  } finally {
    let failed = false;
    try { temp.disposeAll(); } catch { failed = true; }
    try { uninstall(); } catch { failed = true; }
    try {
      if (existsSync(base) && readdirSync(base).length > 0) failed = true;
    } catch { failed = true; }
    try { rmSync(base, { recursive: true, force: true }); } catch { failed = true; }
    tempClean = !failed;
  }

  const coverage = [...store.all("coverage")];
  for (const c of coverage) {
    const unknown = Object.values(c.unknownTypes).reduce((a, b) => a + b, 0);
    if (c.status === "drift" || unknown > 0) warnings.push({ code: "drift", tool: c.tool, source: c.source, detail: `${unknown} unknown types` });
    if (c.note === "too-large") warnings.push({ code: "too-large", tool: c.tool, source: c.source, detail: "too-large" });
  }
  if (!tempClean) warnings.push({ code: "temp-leftover", tool: "scan", source: "scan", detail: "cleanup-failed" });
  return { store, coverage, warnings, cwds, salt, startedAt, finishedAt: Date.now(), tempClean };
}
