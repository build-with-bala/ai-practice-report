import { randomBytes } from "node:crypto";
import { detectEnv, type Env } from "./env/env";
import { homesToScan } from "./env/paths";
import { reraise, trapSignals, type TermSignal } from "./io/signals";
import { ScanTemp } from "./io/temp";
import { maybeYield } from "./io/yield";
import type { CoverageEv, Ev } from "./model/events";
import type { ToolId } from "./model/ids";
import { EventStore } from "./model/store";
import { withCheckCategory } from "./sources/common/tools";
import { registry } from "./sources/registry";
import type { Candidate, ScanCtx, SourcePlugin, TempDirs } from "./sources/types";
import { keyedHash, normalizePath } from "./text/hash";

export interface ScanOptions { env?: Env; plugins?: SourcePlugin[]; tools?: ToolId[]; since?: number; wsl?: boolean; salt?: Uint8Array;
  /** Plugin candidates read at once: a finite integer of at least 1; anything else means the default, 4. */
  concurrency?: number;
  onProgress?: (p: { plugin: string; done: number; total: number }) => void;
  /**
   * Aborts the scan. Plugins stop at their next check (JSONL readers within about 25 ms; a synchronous SQLite pass at
   * its next page); the scan cleans up its temp files and resolves with what was read: every coverage a plugin emits
   * after the abort says `status: "error", note: "aborted"` (its counts and the events before it are kept, but the
   * source was not read to its end), and plugins that never started get the same coverage, empty.
   */
  signal?: AbortSignal;
  /**
   * Signal policy, default true: while scan() runs it traps SIGINT and SIGTERM. The first one aborts the scan (as
   * `signal` does), which unwinds through its cleanup — private copies and the `aipr-scan-*` folder are removed — and
   * then raises the same signal again with the trap released: by its default action the process ends, by that signal
   * (a non-zero exit status), and nothing after scan() runs. Pass false when the application owns these signals:
   * scan() installs no handler, and the application aborts it through `signal` to get the partial result.
   */
  handleSignals?: boolean;
  onLog?: (level: "debug" | "info" | "warn", code: string, n?: number) => void;
  /** @internal test hook: builds the temp registry inside the scan's temp folder, when a private copy first needs one. */
  tempFactory?: (base: string) => TempDirs }
export interface Warning { code: "drift" | "error" | "too-large" | "temp-leftover" | "beta"; tool: ToolId | "scan"; source: string; detail: string }
export interface ScanResult { store: EventStore; coverage: CoverageEv[]; warnings: Warning[]; cwds: Map<string, string>;
  salt: Uint8Array; startedAt: number; finishedAt: number; tempClean: boolean }

const DEFAULT_CONCURRENCY = 4;

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
  const stop = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, stop.signal]) : stop.signal;
  let caught: TermSignal | undefined;
  const release = opts.handleSignals === false ? undefined : trapSignals((sig) => {
    caught ??= sig;
    stop.abort();
  });
  const temp = new ScanTemp(env.tmp, opts.tempFactory);
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
        emit: (e: Ev) => {
          if (e.k === "tool") withCheckCategory(e);
          if (e.k !== "coverage") nonCoverage.set(plugin, (nonCoverage.get(plugin) ?? 0) + 1);
          // a coverage written after the abort may describe a source read only in part: it never looks complete
          else if (signal.aborted) e = { ...e, status: "error", note: "aborted" };
          store.add(e);
        },
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
        const name = signal.aborted ? "aborted" : (e as Error)?.constructor?.name ?? "Error";
        store.add(emptyCoverage(plugin, "error", name));
        warnings.push({ code: "error", tool: plugin.tool, source: plugin.id, detail: name });
      }
      done++;
      safe(() => opts.onProgress?.({ plugin: plugin.id, done, total }));
    };
    const worker = async () => {
      while (next < jobs.length) {
        const pause = maybeYield(); // a plugin that never awaits still lets signals and timers in between jobs
        if (pause) await pause;
        if (signal.aborted) break;
        const i = next++;
        started.add(i);
        try { await runJob(jobs[i]!); } catch { /* runJob should not throw; never reject a worker */ }
      }
    };
    const want = opts.concurrency;
    const width = typeof want === "number" && Number.isInteger(want) && want >= 1 ? want : DEFAULT_CONCURRENCY;
    const n = Math.max(1, Math.min(width, jobs.length));
    await Promise.allSettled(Array.from({ length: n }, worker));

    jobs.forEach((j, i) => { if (!started.has(i)) aborted.add(j.plugin); });
    for (const plugin of aborted) store.add(emptyCoverage(plugin, "error", "aborted"));
    if (aborted.size > 0) warnings.push({ code: "error", tool: "scan", source: "scan", detail: "aborted" });

    for (const [plugin, count] of nonCoverage) {
      if (plugin.beta && count > 0) warnings.push({ code: "beta", tool: plugin.tool, source: plugin.id, detail: "beta reader" });
    }
  } finally {
    tempClean = temp.close();
    release?.();
  }

  const coverage = [...store.all("coverage")];
  for (const c of coverage) {
    const unknown = Object.values(c.unknownTypes).reduce((a, b) => a + b, 0);
    if (c.status === "drift" || unknown > 0) warnings.push({ code: "drift", tool: c.tool, source: c.source, detail: `${unknown} unknown types` });
    if (c.note === "too-large") warnings.push({ code: "too-large", tool: c.tool, source: c.source, detail: "too-large" });
  }
  if (!tempClean) warnings.push({ code: "temp-leftover", tool: "scan", source: "scan", detail: "cleanup-failed" });
  // cleaned up: a trapped SIGINT/SIGTERM now takes its default action, ending the process before anything after scan()
  if (caught !== undefined) reraise(caught);
  return { store, coverage, warnings, cwds, salt, startedAt, finishedAt: Date.now(), tempClean };
}
