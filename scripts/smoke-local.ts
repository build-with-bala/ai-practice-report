// Local acceptance run: scans this machine's real stores with every P0 plugin, analyzes and exports the result, and
// prints COUNTS ONLY — never names, paths, ids, text, scores or bands, and no date finer than a month. Every
// `key=value` value is a number, a ratio, `n/a` or `-`, a boolean, a month span, a short code or `PASS`/`FAIL` (the
// grammar test/scripts/smoke.test.ts pins); a key holds no `=`. Exit code 1 when a P0 plugin errors, the scan leaves
// temp files, an analysis check fails, scan plus analyze takes over 60 s, the peak RSS exceeds 1 GiB, or too few Codex
// command events had a command line to classify.
//   bun scripts/smoke-local.ts [--concurrency <n>]
import path from "node:path";
import { detectEnv, type Env } from "../core/env/env";
import { homesToScan } from "../core/env/paths";
import { analyze, ExportError, exportPayload, registry, scan, type Analysis, type CoverageEv, type ScanResult } from "../core/index";
import { safeList, walk } from "../core/io/fs";
import { ccTranscripts } from "../core/sources/claude-code";
import { SHELL_TOOLS } from "../core/sources/codex/tools";

const MiB = 1024 * 1024;
const BUDGET_SECONDS = 60;
const BUDGET_RSS = 1024 * MiB;
const MIN_EXTRACTED_SHARE = 0.9;
/** The export's size bound, in bytes (pre-flight P19). */
const MAX_EXPORT_BYTES = 300_000;
const BANDS: ReadonlySet<string> = new Set(["consistent", "consistent-with-notes", "inconsistent", "unverifiable"]);
/** The forensic checks that always run, C1–C10 (the soft flags follow them). */
const FORENSIC_CHECKS = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10"];
/** The first day of VS Code's journal format for chat sessions, as the spec's acceptance check names it. */
const COPILOT_JOURNAL_SINCE = Date.UTC(2026, 1, 23);
const DAY_MS = 86_400_000;
/** Skip reasons and log codes are fixed tokens; anything else is printed as `other`. */
const CODE = /^[a-z][a-z0-9_.:-]{0,47}$/;

const code = (s: string): string => (CODE.test(s) ? s : "other");
const month = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
/** A coverage span in months; `-..-` unless both ends are known. */
const span = (from: number | undefined, to: number | undefined): string =>
  from === undefined || to === undefined ? "-..-" : `${month(from)}..${month(to)}`;
const share = (n: number, of: number): string => (of === 0 ? "n/a" : (n / of).toFixed(3));
const mib = (bytes: number): string => `${Math.round(bytes / MiB)} MiB`;
const tally = (into: Map<string, number>, key: string, n = 1): void => {
  into.set(key, (into.get(key) ?? 0) + n);
};
const pairs = (m: Map<string, number> | Record<string, number>): string =>
  [...(m instanceof Map ? m : Object.entries(m))].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k}=${n}`).join(" ") || "-";

/** `$TMPDIR/aipr-*` entries: what a scan (or a test) left behind. */
const tempLeftovers = (env: Env): number => safeList(env.tmp).filter((n) => n.startsWith("aipr-")).length;

/** `subagents/**\/agent-*.jsonl` under every session folder of every Claude Code root, counted by name, never opened. */
function subagentFiles(env: Env): number {
  let n = 0;
  for (const { root } of ccTranscripts.locate(env, homesToScan(env, false))) {
    const projects = path.join(root, "projects");
    for (const project of safeList(projects)) {
      for (const session of safeList(path.join(projects, project))) {
        const dir = path.join(projects, project, session, "subagents");
        n += walk(dir, { maxDepth: 8, match: (name, isDir) => !isDir && /^agent-.+\.jsonl$/.test(name) }).length;
      }
    }
  }
  return n;
}

export function coverageLine(c: CoverageEv): string {
  const skipped = new Map<string, number>();
  for (const [reason, n] of Object.entries(c.skipped)) tally(skipped, code(reason), n);
  const unknown = Object.values(c.unknownTypes);
  return [
    c.source.padEnd(24), c.window.padEnd(8), c.status.padEnd(19), `files=${c.files}`, `records=${c.records}`,
    `unknown=${unknown.length}/${unknown.reduce((a, b) => a + b, 0)}`, `span=${span(c.from, c.to)}`, `skipped: ${pairs(skipped)}`,
  ].join(" ");
}

/**
 * Samples the process RSS every 250 ms on its own thread: a scan keeps the main thread busy without returning to the
 * event loop, so a timer there would not fire until the scan is over.
 */
const SAMPLER = `let peak = 0, samples = 0;
const tick = () => { peak = Math.max(peak, process.memoryUsage().rss); samples++; };
tick();
const timer = setInterval(tick, 250);
onmessage = () => { clearInterval(timer); tick(); postMessage({ peak, samples }); };`;

interface Samples { peak: number; samples: number }

interface Sampler {
  /** Stops the sampler and gives the peak it saw. */
  stop(): Promise<Samples>;
  /** Ends the worker without a reading; a no-op once stopped. */
  kill(): void;
}

/** Starts the sampler. Its worker keeps the process alive until `stop` or `kill`. */
function startSampler(): Sampler {
  const worker = new Worker(URL.createObjectURL(new Blob([SAMPLER], { type: "application/javascript" })));
  let ended = false;
  const kill = (): void => {
    if (ended) return;
    ended = true;
    worker.terminate();
  };
  const stop = (): Promise<Samples> => new Promise<Samples>((resolve) => {
    worker.onmessage = (e: MessageEvent<Samples>) => {
      kill();
      resolve(e.data);
    };
    worker.postMessage("stop");
  });
  return { stop, kill };
}

/** The export's outcome: its canonical bytes, or (when the schema refuses the analysis) how many paths it named. */
export type Exported = { ok: true; json: string; bytes: number } | { ok: false; violations: number };

/** Exports `a`; an `ExportError` becomes a count of its paths (never the paths), and any other error is thrown. */
export function exportOf(a: Analysis): Exported {
  try {
    const { json, bytes } = exportPayload(a, { schema: "aiprof/2" });
    return { ok: true, json, bytes };
  } catch (e) {
    if (e instanceof ExportError) return { ok: false, violations: e.paths.length };
    throw e;
  }
}

/** Every object in `v` with a `value` key holding a number or null (a metric) that lacks a window or a finite count. */
function metricsWithoutMeta(v: unknown, out = { metrics: 0, bad: 0 }): typeof out {
  if (v === null || typeof v !== "object") return out;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(v) && "value" in o && (o.value === null || typeof o.value === "number")) {
    out.metrics++;
    if (!(o.window === "detail" || o.window === "lifetime") || typeof o.n !== "number" || !Number.isFinite(o.n)) out.bad++;
  }
  for (const x of Object.values(o)) metricsWithoutMeta(x, out);
  return out;
}

/**
 * The raw paths an export must never hold: the home, every session cwd and every repo root, as written and as JSON
 * escapes them. A file-system root (`/`, `C:\`) is no path of anyone's, so it is left out.
 */
function rawPaths(r: ScanResult, home: string): string[] {
  const out = new Set<string>();
  for (const p of [home, ...r.cwds.values(), ...r.repos.roots.values()]) {
    if (p === "" || path.parse(p).root === p) continue;
    out.add(p);
    out.add(JSON.stringify(p).slice(1, -1));
  }
  return [...out];
}

const passFail = (ok: boolean): string => (ok ? "PASS" : "FAIL");

/**
 * The analysis checks (Task 16), as lines of counts and PASS/FAIL, and the names of those that failed. A refused export
 * prints the count of the paths it named and fails both export checks.
 */
export function analysisLines(r: ScanResult, a: Analysis, exported: Exported, home: string): { lines: string[]; failures: string[] } {
  const lines: string[] = [];
  const failures: string[] = [];
  const check = (key: string, ok: boolean): void => {
    lines.push(`${key}=${passFail(ok)}`);
    if (!ok) failures.push(key);
  };
  const scored = a.dimensions.filter((d) => d.status === "scored");
  lines.push(`dimensions scored=${scored.length}/${a.dimensions.length}`);
  check("not-saturated", scored.every((d) => d.score !== 99 || d.openTail));
  const m = metricsWithoutMeta(a);
  check("metrics-have-window-and-n", m.metrics > 0 && m.bad === 0);
  if (!exported.ok) lines.push(`export-violations=${exported.violations}`);
  const needles = rawPaths(r, home);
  check("export-no-raw-paths", exported.ok && !needles.some((p) => exported.json.includes(p)));
  check("export-under-300kb", exported.ok && exported.bytes <= MAX_EXPORT_BYTES);
  const ids = new Set<string>(a.forensics.checks.map((c) => c.id));
  check("forensics-ran", BANDS.has(a.forensics.band) && FORENSIC_CHECKS.every((id) => ids.has(id)));
  lines.push(`repo-signals=${code(r.repos.status)} repos=${r.repos.repos.length}`);
  return { lines, failures };
}

interface Run { r: ScanResult; a: Analysis; exported: Exported; seconds: number; analysisSeconds: number; peakRss: number; samples: number;
  osPeakRss?: number; logs: Map<string, number>; before: number; after: number }

/** Scans, analyzes and exports, sampling the RSS across all three. */
async function run(env: Env, concurrency: number | undefined): Promise<Run> {
  const before = tempLeftovers(env);
  const sampler = startSampler();
  const logs = new Map<string, number>();
  let r: ScanResult;
  let a: Analysis;
  let exported: Exported;
  let sampled: Samples;
  let seconds: number;
  let analysisSeconds: number;
  try {
    const started = performance.now();
    r = await scan({ env, wsl: false, concurrency, onLog: (level, c, n) => tally(logs, `${level} ${code(c)}`, n ?? 1) });
    seconds = (performance.now() - started) / 1000;
    const analyzing = performance.now();
    a = analyze(r);
    analysisSeconds = (performance.now() - analyzing) / 1000;
    exported = exportOf(a);
    sampled = await sampler.stop();
  } finally {
    sampler.kill(); // a scan that throws must not leave the worker holding the process open
  }
  const peakRss = Math.max(sampled.peak, process.memoryUsage().rss);
  // getrusage's high-water mark — bytes on macOS, KiB on Linux (Bun passes it through) — cross-checks the samples
  const maxRss = process.resourceUsage().maxRSS;
  const osPeakRss = process.platform === "darwin" ? maxRss : process.platform === "linux" ? maxRss * 1024 : undefined;
  return { r, a, exported, seconds, analysisSeconds, peakRss, samples: sampled.samples, osPeakRss, logs, before, after: tempLeftovers(env) };
}

export async function main(argv: string[]): Promise<number> {
  const i = argv.indexOf("--concurrency");
  const concurrency = i >= 0 ? Number(argv[i + 1]) : undefined;
  if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency > 0)) throw new Error("--concurrency takes a positive integer");
  const env = detectEnv();
  const { r, a, exported, seconds, analysisSeconds, peakRss, samples, osPeakRss, logs, before, after } = await run(env, concurrency);
  const out: string[] = [];
  const failures: string[] = [];

  out.push(`== coverage (${registry.length} P0 plugins)`);
  for (const c of [...r.coverage].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0))) out.push(coverageLine(c));
  const p0 = new Set(registry.filter((p) => p.tier === "P0").map((p) => p.id));
  const errored = r.coverage.filter((c) => p0.has(c.source) && c.status === "error").length;
  if (errored > 0) failures.push(`${errored} P0 coverage error(s)`);

  out.push("== events by kind", pairs(r.store.count() as Record<string, number>));
  const prompts = new Map<string, Map<string, number>>();
  for (const p of r.store.all("prompt")) {
    if (!prompts.has(p.tool)) prompts.set(p.tool, new Map());
    tally(prompts.get(p.tool)!, p.origin);
  }
  out.push("== prompts by tool and origin");
  for (const [tool, byOrigin] of [...prompts].sort(([a], [b]) => (a < b ? -1 : 1))) out.push(`${tool.padEnd(12)} ${pairs(byOrigin)}`);

  out.push("== checks");
  const sessions = r.store.all("session");
  const subagentSessions = sessions.filter((s) => s.source === "claude-code.transcripts" && s.origin === "subagent").length;
  const onDisk = subagentFiles(env);
  out.push(`claude-code subagent sessions=${subagentSessions} subagent files on disk=${onDisk} ${subagentSessions === onDisk ? "(equal)" : "(MISMATCH)"}`);
  const extracted = logs.get("debug codex.cmd-extracted") ?? 0;
  const missing = logs.get("debug codex.cmd-missing") ?? 0;
  out.push(`codex command events with a command line=${extracted} without=${missing} extracted share=${share(extracted, extracted + missing)} (gate: at least ${MIN_EXTRACTED_SHARE})`);
  if (extracted + missing > 0 && extracted / (extracted + missing) < MIN_EXTRACTED_SHARE) failures.push("codex extracted-command share below the gate");
  const codexTools = r.store.all("tool").filter((t) => t.tool === "codex");
  const codexCommands = codexTools.filter((t) => SHELL_TOOLS.has(t.name)); // Codex's shell-command tools
  const notShell = (list: typeof codexTools) => list.filter((t) => t.category !== "shell").length;
  out.push(`codex tool events=${codexTools.length} non-shell share=${share(notShell(codexTools), codexTools.length)}`);
  out.push(`codex command events=${codexCommands.length} non-shell share=${share(notShell(codexCommands), codexCommands.length)}`);
  const copilotSince = (ms: number) => sessions.filter((s) => s.tool === "copilot" && s.start >= ms).length;
  out.push(`copilot sessions since the journal format's first day=${copilotSince(COPILOT_JOURNAL_SINCE)} since its second day=${copilotSince(COPILOT_JOURNAL_SINCE + DAY_MS)}`);
  out.push(`antigravity IDE trajectories=${sessions.filter((s) => s.source === "antigravity.ide").length}`);

  out.push("== warnings and logs");
  const warnings = new Map<string, number>();
  for (const w of r.warnings) tally(warnings, `${w.code}:${w.source}`);
  out.push(`warnings: ${pairs(warnings)}`, `logs: ${pairs(logs)}`);

  out.push("== analysis", `analysis elapsed=${analysisSeconds.toFixed(1)}`);
  const analysis = analysisLines(r, a, exported, env.home);
  out.push(...analysis.lines);
  if (analysis.failures.length > 0) failures.push(`analysis check(s) failed: ${analysis.failures.join(", ")}`);

  out.push("== budgets");
  const read = r.coverage.reduce((n, c) => n + c.bytes, 0);
  const files = r.coverage.reduce((n, c) => n + c.files, 0);
  out.push(`elapsed=${seconds.toFixed(1)} s (budget ${BUDGET_SECONDS} s for scan plus analysis) concurrency=${concurrency ?? "default"} read=${mib(read)} in ${files} files`);
  out.push(`peak RSS sampled every 250 ms=${mib(peakRss)} (${samples} samples)${osPeakRss === undefined ? "" : ` os-reported peak=${mib(osPeakRss)}`} (budget ${mib(BUDGET_RSS)})`);
  out.push(`tempClean=${r.tempClean} $TMPDIR/aipr-* before=${before} after=${after}`);
  if (seconds + analysisSeconds > BUDGET_SECONDS) failures.push("scan plus analysis over budget");
  if (Math.max(peakRss, osPeakRss ?? 0) > BUDGET_RSS) failures.push("peak RSS over budget");
  if (!r.tempClean) failures.push("temp not clean");
  if (after > 0) failures.push("aipr-* temp dirs left in $TMPDIR");

  out.push(failures.length === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures.join("; ")})`);
  console.log(out.join("\n"));
  return failures.length === 0 ? 0 : 1;
}

/** An error's class name only: its message or stack could carry a path or text from a trace. */
const errorClass = (e: unknown): string => (e instanceof Error ? e.constructor.name : typeof e);

if (import.meta.main) {
  for (const event of ["unhandledRejection", "uncaughtException"] as const) {
    process.on(event, (e: unknown) => {
      console.log(`error: ${errorClass(e)}`);
      process.exit(1);
    });
  }
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    console.log(`error: ${errorClass(e)}`);
    process.exitCode = 1;
  }
}
