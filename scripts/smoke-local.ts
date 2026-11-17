// Local acceptance run: scans this machine's real stores with every P0 plugin and prints COUNTS ONLY — never names,
// paths, ids or text. Exit code 1 when a P0 plugin errors, the scan leaves temp files, a budget is exceeded, or too
// few Codex command events had a command line to classify.
//   bun scripts/smoke-local.ts [--concurrency <n>]
import path from "node:path";
import { detectEnv, type Env } from "../core/env/env";
import { homesToScan } from "../core/env/paths";
import { registry, scan, type CoverageEv, type ScanResult } from "../core/index";
import { safeList, walk } from "../core/io/fs";
import { ccTranscripts } from "../core/sources/claude-code";

const MiB = 1024 * 1024;
const BUDGET_SECONDS = 60;
const BUDGET_RSS = 1024 * MiB;
const MIN_EXTRACTED_SHARE = 0.9;
/** VS Code writes chat sessions as journals from 2026-02-23 on (the legacy JSON files end that day). */
const COPILOT_JOURNAL_SINCE = Date.UTC(2026, 1, 23);
const DAY_MS = 86_400_000;
/** Codex's shell-command tools (built-in names). */
const CODEX_COMMAND_TOOLS = new Set(["exec_command", "shell", "shell_command", "container.exec", "local_shell"]);
/** Skip reasons and log codes are fixed tokens; anything else is printed as `other`. */
const CODE = /^[a-z][a-z0-9_.:-]{0,47}$/;

const code = (s: string): string => (CODE.test(s) ? s : "other");
const month = (ms: number | undefined): string => (ms === undefined ? "-" : new Date(ms).toISOString().slice(0, 7));
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

function coverageLine(c: CoverageEv): string {
  const skipped = new Map<string, number>();
  for (const [reason, n] of Object.entries(c.skipped)) tally(skipped, code(reason), n);
  const unknown = Object.values(c.unknownTypes);
  return [
    c.source.padEnd(24), c.window.padEnd(8), c.status.padEnd(19), `files=${c.files}`, `records=${c.records}`,
    `unknown=${unknown.length}/${unknown.reduce((a, b) => a + b, 0)}`, `span=${month(c.from)}..${month(c.to)}`, `skipped: ${pairs(skipped)}`,
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

/** Starts the sampler; the function returned stops it and gives the peak it saw. */
function startSampler(): () => Promise<Samples> {
  const worker = new Worker(URL.createObjectURL(new Blob([SAMPLER], { type: "application/javascript" })));
  return () => new Promise<Samples>((resolve) => {
    worker.onmessage = (e: MessageEvent<Samples>) => {
      worker.terminate();
      resolve(e.data);
    };
    worker.postMessage("stop");
  });
}

interface Run { r: ScanResult; seconds: number; peakRss: number; samples: number; osPeakRss?: number; logs: Map<string, number>; before: number; after: number }

async function run(env: Env, concurrency: number | undefined): Promise<Run> {
  const before = tempLeftovers(env);
  const stopSampler = startSampler();
  const logs = new Map<string, number>();
  const started = performance.now();
  const r = await scan({ env, wsl: false, concurrency, onLog: (level, c, n) => tally(logs, `${level} ${code(c)}`, n ?? 1) });
  const seconds = (performance.now() - started) / 1000;
  const sampled = await stopSampler();
  const peakRss = Math.max(sampled.peak, process.memoryUsage().rss);
  // getrusage's high-water mark — bytes on macOS, KiB on Linux (Bun passes it through) — cross-checks the samples
  const maxRss = process.resourceUsage().maxRSS;
  const osPeakRss = process.platform === "darwin" ? maxRss : process.platform === "linux" ? maxRss * 1024 : undefined;
  return { r, seconds, peakRss, samples: sampled.samples, osPeakRss, logs, before, after: tempLeftovers(env) };
}

export async function main(argv: string[]): Promise<number> {
  const i = argv.indexOf("--concurrency");
  const concurrency = i >= 0 ? Number(argv[i + 1]) : undefined;
  if (concurrency !== undefined && !(Number.isInteger(concurrency) && concurrency > 0)) throw new Error("--concurrency takes a positive integer");
  const env = detectEnv();
  const { r, seconds, peakRss, samples, osPeakRss, logs, before, after } = await run(env, concurrency);
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
  out.push(`codex command events with a command line=${extracted} without=${missing} extracted share=${share(extracted, extracted + missing)} (gate >= ${MIN_EXTRACTED_SHARE})`);
  if (extracted + missing > 0 && extracted / (extracted + missing) < MIN_EXTRACTED_SHARE) failures.push("codex extracted-command share below the gate");
  const codexTools = r.store.all("tool").filter((t) => t.tool === "codex");
  const codexCommands = codexTools.filter((t) => CODEX_COMMAND_TOOLS.has(t.name));
  const notShell = (list: typeof codexTools) => list.filter((t) => t.category !== "shell").length;
  out.push(`codex tool events=${codexTools.length} non-shell share=${share(notShell(codexTools), codexTools.length)}; command events=${codexCommands.length} non-shell share=${share(notShell(codexCommands), codexCommands.length)}`);
  const copilotSince = (ms: number) => sessions.filter((s) => s.tool === "copilot" && s.start >= ms).length;
  out.push(`copilot sessions from 2026-02-23 (journal format)=${copilotSince(COPILOT_JOURNAL_SINCE)} from 2026-02-24=${copilotSince(COPILOT_JOURNAL_SINCE + DAY_MS)}`);
  out.push(`antigravity IDE trajectories=${sessions.filter((s) => s.source === "antigravity.ide").length}`);

  out.push("== warnings and logs");
  const warnings = new Map<string, number>();
  for (const w of r.warnings) tally(warnings, `${w.code}:${w.source}`);
  out.push(`warnings: ${pairs(warnings)}`, `logs: ${pairs(logs)}`);

  out.push("== budgets");
  const read = r.coverage.reduce((n, c) => n + c.bytes, 0);
  const files = r.coverage.reduce((n, c) => n + c.files, 0);
  out.push(`elapsed=${seconds.toFixed(1)} s (budget ${BUDGET_SECONDS} s) concurrency=${concurrency ?? "default"} read=${mib(read)} in ${files} files`);
  out.push(`peak RSS sampled every 250 ms=${mib(peakRss)} (${samples} samples)${osPeakRss === undefined ? "" : ` os-reported peak=${mib(osPeakRss)}`} (budget ${mib(BUDGET_RSS)})`);
  out.push(`tempClean=${r.tempClean} $TMPDIR/aipr-* before=${before} after=${after}`);
  if (seconds > BUDGET_SECONDS) failures.push("elapsed over budget");
  if (Math.max(peakRss, osPeakRss ?? 0) > BUDGET_RSS) failures.push("peak RSS over budget");
  if (!r.tempClean) failures.push("temp not clean");
  if (after > 0) failures.push("aipr-* temp dirs left in $TMPDIR");

  out.push(failures.length === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures.join("; ")})`);
  console.log(out.join("\n"));
  return failures.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    console.log(`error: ${(e as Error)?.constructor?.name ?? "Error"}`);
    process.exitCode = 1;
  }
}
