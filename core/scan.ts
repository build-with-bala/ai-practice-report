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
import type { Candidate, ScanCtx, SourcePlugin } from "./sources/types";
import { keyedHash, normalizePath } from "./text/hash";

export interface ScanOptions { env?: Env; plugins?: SourcePlugin[]; tools?: ToolId[]; since?: number; wsl?: boolean; salt?: Uint8Array;
  concurrency?: number; onProgress?: (p: { plugin: string; done: number; total: number }) => void; signal?: AbortSignal;
  onLog?: (level: "debug" | "info" | "warn", code: string, n?: number) => void }
export interface Warning { code: "drift" | "error" | "too-large" | "temp-leftover" | "beta"; tool: ToolId; source: string; detail: string }
export interface ScanResult { store: EventStore; coverage: CoverageEv[]; warnings: Warning[]; cwds: Map<string, string>;
  salt: Uint8Array; startedAt: number; finishedAt: number; tempClean: boolean }

function emptyCoverage(p: SourcePlugin, status: CoverageEv["status"], note?: string): CoverageEv {
  const ev: CoverageEv = { k: "coverage", tool: p.tool, source: p.id, window: "detail", status, beta: p.beta,
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
  const temp = new TempRegistry(base);
  const uninstall = installSignalCleanup(temp);
  let tempClean = false;

  try {
    const jobs: { plugin: SourcePlugin; cand: Candidate }[] = [];
    for (const plugin of plugins) {
      let cands: Candidate[] = [];
      try {
        cands = plugin.locate(env, homes);
      } catch (e) {
        store.add(emptyCoverage(plugin, "error", (e as Error)?.constructor?.name ?? "Error"));
        warnings.push({ code: "error", tool: plugin.tool, source: plugin.id, detail: (e as Error)?.constructor?.name ?? "Error" });
        continue;
      }
      if (cands.length === 0) store.add(emptyCoverage(plugin, "absent"));
      for (const cand of cands) jobs.push({ plugin, cand });
    }

    const total = jobs.length;
    let done = 0;
    let next = 0;
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
        log: (level, code, n) => opts.onLog?.(level, code, n),
      };
      try {
        await plugin.scan(cand, ctx);
      } catch (e) {
        const name = (e as Error)?.constructor?.name ?? "Error";
        store.add(emptyCoverage(plugin, "error", name));
        warnings.push({ code: "error", tool: plugin.tool, source: plugin.id, detail: name });
      }
      done++;
      opts.onProgress?.({ plugin: plugin.id, done, total });
    };
    const worker = async () => {
      while (!signal.aborted && next < jobs.length) await runJob(jobs[next++]!);
    };
    const n = Math.max(1, Math.min(opts.concurrency ?? 4, jobs.length));
    await Promise.all(Array.from({ length: n }, worker));

    for (const [plugin, count] of nonCoverage) {
      if (plugin.beta && count > 0) warnings.push({ code: "beta", tool: plugin.tool, source: plugin.id, detail: "beta reader" });
    }
  } finally {
    temp.disposeAll();
    uninstall();
    try {
      tempClean = existsSync(base) ? readdirSync(base).length === 0 : true;
    } catch {
      tempClean = false;
    }
    rmSync(base, { recursive: true, force: true });
  }

  const coverage = [...store.all("coverage")];
  for (const c of coverage) {
    const unknown = Object.values(c.unknownTypes).reduce((a, b) => a + b, 0);
    if (c.status === "drift" || unknown > 0) warnings.push({ code: "drift", tool: c.tool, source: c.source, detail: `${unknown} unknown types` });
    if (c.note === "too-large") warnings.push({ code: "too-large", tool: c.tool, source: c.source, detail: "too-large" });
  }
  if (!tempClean) warnings.push({ code: "temp-leftover", tool: "claude-code", source: "scan", detail: "temp dirs remained" });
  return { store, coverage, warnings, cwds, salt, startedAt, finishedAt: Date.now(), tempClean };
}
