import { randomBytes } from "node:crypto";
import { detectEnv, type Env } from "./env/env";
import { homesToScan } from "./env/paths";
import { enterScanTrap } from "./io/signals";
import { ScanTemp } from "./io/temp";
import { maybeYield } from "./io/yield";
import type { CoverageEv, Ev } from "./model/events";
import type { PluginCoverage } from "./sources/types";
import type { ToolId } from "./model/ids";
import { EventStore } from "./model/store";
import { INERT_SKIPS } from "./sources/common/coverage";
import { withCheckCategory } from "./sources/common/tools";
import { registry } from "./sources/registry";
import { windowsOf, type Candidate, type ScanCtx, type SourcePlugin, type TempDirs } from "./sources/types";
import { keyedHash, normalizePath } from "./text/hash";

export interface ScanOptions { env?: Env; plugins?: SourcePlugin[]; tools?: ToolId[]; since?: number; wsl?: boolean; salt?: Uint8Array;
  /** Plugin candidates read at once: a finite integer of at least 1; anything else means the default, 4. */
  concurrency?: number;
  onProgress?: (p: { plugin: string; done: number; total: number }) => void;
  /**
   * Aborts the scan. Plugins stop at their next check (JSONL readers within about 25 ms; an SQLite pass at its next
   * page); the scan cleans up its temp files and resolves with what was read: every coverage a plugin emits
   * after the abort says `status: "error", note: "aborted"` (its counts and the events before it are kept, but the
   * source was not read to its end), and plugins that never started get the same coverage, empty.
   */
  signal?: AbortSignal;
  /**
   * Signal policy, default true: while scan() runs it traps SIGINT and SIGTERM, in one trap that every scan running at
   * once shares. The first signal aborts them all (as `signal` does); each unwinds through its cleanup — private copies
   * and its `aipr-scan-*` folder are removed — and once the last has, the same signal is raised again with the trap
   * released: by its default action the process ends, by that signal (a non-zero exit status), and nothing after
   * scan() runs. A signal that lands in a scan's last synchronous work is caught too: scan() gives the event loop a
   * turn before it leaves the trap. A second signal ends the process at once, once every scan's temp files are removed.
   * Pass false when the application owns these signals: scan() installs no handler, and the application aborts it
   * through `signal` to get the partial result.
   */
  handleSignals?: boolean;
  onLog?: (level: "debug" | "info" | "warn", code: string, n?: number) => void;
  /** @internal test hook: builds the temp registry inside the scan's temp folder, when a private copy first needs one. */
  tempFactory?: (base: string) => TempDirs }
export interface Warning { code: "drift" | "error" | "too-large" | "temp-leftover" | "beta"; tool: ToolId | "scan"; source: string; detail: string }
export interface ScanResult { store: EventStore; coverage: CoverageEv[]; warnings: Warning[]; cwds: Map<string, string>;
  salt: Uint8Array; startedAt: number; finishedAt: number; tempClean: boolean }

const DEFAULT_CONCURRENCY = 4;
/** Event kinds that say their window; every other kind counts toward any window of its plugin. */
const WINDOWED: ReadonlySet<string> = new Set(["session", "prompt", "turn"]);
const yieldKey = (k: string, window: string): string => (WINDOWED.has(k) ? `${k}@${window}` : k);
/** The records of a coverage that should have yielded events: all those read, but for the ones skipped on purpose. */
const yielding = (c: CoverageEv): number => c.records - INERT_SKIPS.reduce((n, r) => n + (c.skipped[r] ?? 0), 0);

/** Coverage the orchestrator writes for a plugin (absent, error, aborted): one per window the plugin reports. */
function emptyCoverage(p: SourcePlugin, status: CoverageEv["status"], note?: string): CoverageEv[] {
  return windowsOf(p).map((window) => {
    const ev: CoverageEv = { k: "coverage", tool: p.tool, source: p.id, window, status, beta: p.beta,
      files: 0, bytes: 0, records: 0, skipped: {}, unknownTypes: {}, versions: [] };
    if (note !== undefined) ev.note = note;
    return ev;
  });
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
  const temp = new ScanTemp(env.tmp, opts.tempFactory);
  const trap = opts.handleSignals === false ? undefined : enterScanTrap({ abort: () => stop.abort(), closeSync: () => { temp.close(); } });
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
        for (const c of emptyCoverage(plugin, "error", name)) store.add(c);
        warnings.push({ code: "error", tool: plugin.tool, source: plugin.id, detail: name });
        continue;
      }
      if (cands.length === 0) for (const c of emptyCoverage(plugin, "absent")) store.add(c);
      for (const cand of cands) jobs.push({ plugin, cand });
    }

    const total = jobs.length;
    let done = 0;
    let next = 0;
    const started = new Set<number>();
    const safe = (f: () => void) => { try { f(); } catch { /* caller callbacks never fail a scan */ } };
    const runJob = async ({ plugin, cand }: { plugin: SourcePlugin; cand: Candidate }): Promise<void> => {
      const yielded = new Map<string, number>(); // this candidate's events by kind (and window, for windowed kinds)
      const ctx: ScanCtx = {
        env, now, since: opts.since, salt, temp, signal,
        emit: (e: Ev | PluginCoverage) => {
          if (e.k !== "coverage") {
            if (e.k === "tool") withCheckCategory(e);
            nonCoverage.set(plugin, (nonCoverage.get(plugin) ?? 0) + 1);
            const key = yieldKey(e.k, (e as { window?: string }).window ?? "");
            yielded.set(key, (yielded.get(key) ?? 0) + 1);
            store.add(e);
            return;
          }
          // the plugin's own flag decides beta
          const cov: CoverageEv = { ...e, beta: plugin.beta };
          const kinds = plugin.primary?.[cov.window];
          // a coverage written after the abort may describe a source read only in part, so it never looks complete: the
          // abort stamp alone decides it
          if (signal.aborted) Object.assign(cov, { status: "error", note: "aborted" });
          // records read, but none of the window's primary kinds yielded: the format moved under the reader. Records read
          // on purpose that yield nothing (INERT_SKIPS) do not count.
          else if (kinds && (cov.status === "ok" || cov.status === "drift") && yielding(cov) > 0 && !kinds.some((k) => (yielded.get(yieldKey(k, cov.window)) ?? 0) > 0)) {
            cov.status = "drift";
            cov.unknownTypes = { ...cov.unknownTypes, "zero-yield": 1 };
          }
          store.add(cov);
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
        for (const c of emptyCoverage(plugin, "error", name)) store.add(c);
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
    for (const plugin of aborted) for (const c of emptyCoverage(plugin, "error", "aborted")) store.add(c);
    if (aborted.size > 0) warnings.push({ code: "error", tool: "scan", source: "scan", detail: "aborted" });

    for (const [plugin, count] of nonCoverage) {
      if (plugin.beta && count > 0) warnings.push({ code: "beta", tool: plugin.tool, source: plugin.id, detail: "beta reader" });
    }
  } finally {
    tempClean = temp.close();
    // cleaned up: a trapped SIGINT/SIGTERM, one caught at the tail included, now ends the process by that signal once
    // every scan inside the trap has cleaned up, so nothing after scan() runs
    await trap?.leave();
  }

  // one drift and one too-large warning per source, whatever the number of its windows; drift a store's two windows
  // share (the same key in both) counts once
  const coverage = [...store.all("coverage")];
  const drift = new Map<string, { tool: ToolId; keys: Map<string, number>; flagged: boolean }>();
  const tooLarge = new Map<string, ToolId>();
  for (const c of coverage) {
    const d = drift.get(c.source) ?? { tool: c.tool, keys: new Map<string, number>(), flagged: false };
    for (const [key, n] of Object.entries(c.unknownTypes)) d.keys.set(key, Math.max(d.keys.get(key) ?? 0, n));
    d.flagged ||= c.status === "drift";
    drift.set(c.source, d);
    if (c.note === "too-large") tooLarge.set(c.source, c.tool);
  }
  for (const [source, d] of drift) {
    const unknown = [...d.keys.values()].reduce((a, b) => a + b, 0);
    if (d.flagged || unknown > 0) warnings.push({ code: "drift", tool: d.tool, source, detail: `${unknown} unknown types` });
  }
  for (const [source, tool] of tooLarge) warnings.push({ code: "too-large", tool, source, detail: "too-large" });
  if (!tempClean) warnings.push({ code: "temp-leftover", tool: "scan", source: "scan", detail: "cleanup-failed" });
  return { store, coverage, warnings, cwds, salt, startedAt, finishedAt: Date.now(), tempClean };
}
