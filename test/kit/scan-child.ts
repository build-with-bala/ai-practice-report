// Spawned by test/core/scan.signals.test.ts. Prints markers: `ready` just before scanning, `copied` once a plugin has
// made its private temp dir (as a busy store's copy does), and `after-scan …` once scan() returned — which must never
// print when a trapped signal ended the scan.
//   bun test/kit/scan-child.ts <home> <tmp> <mode>
//   default:  the core's signal policy; the Claude Code transcripts reader plus a plugin that makes a temp dir
//   owned:    the same, but the application traps SIGINT itself and aborts the scan (handleSignals false)
//   tail:     one plugin that makes a temp dir, then works ~1.5 s synchronously after its last await
//   overlap:  two scans at once (A and B), each with a plugin that works 2 s in yielding slices until it is aborted
//   overlap-listener: the same, while the application keeps a SIGINT listener of its own beside the core's trap
//   stubborn: one plugin that makes a temp dir and ignores the abort, working 3 s in yielding slices
//   late:     scan A works in yielding slices until a signal aborts it; while A unwinds (300 ms more) it starts scan B,
//             which enters the trap after the signal was caught: B's plugin prints `located B` if it is ever located
import { writeFileSync } from "node:fs";
import path from "node:path";
import { detectEnv } from "../../core/env/env";
import { scan } from "../../core/scan";
import { ccTranscripts } from "../../core/sources/claude-code";
import type { ScanCtx, SourcePlugin } from "../../core/sources/types";

type Mode = "default" | "owned" | "tail" | "overlap" | "overlap-listener" | "stubborn" | "late";
const [home, tmp, mode] = process.argv.slice(2) as [string, string, Mode];
const env = detectEnv({ home, tmp, vars: {}, wslHomes: [] });

const SLICE_MS = 25;
/** Synchronous work: nothing else runs until it ends, signal handlers included. */
const spin = (ms: number): void => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { /* busy */ }
};
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Makes the scan's private temp dir and a file in it, and says so. */
function makeCopy(ctx: ScanCtx, label = ""): void {
  writeFileSync(path.join(ctx.temp.dir(), "copy.db"), "x");
  console.log(`copied${label}`);
}

/** Works for `ms` in slices, with a turn of the event loop after each; stops once aborted, unless `ignoreAbort`. */
async function work(ctx: ScanCtx, ms: number, ignoreAbort = false): Promise<void> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms && (ignoreAbort || !ctx.signal.aborted)) {
    spin(SLICE_MS);
    await turn();
  }
}

const plugin = (id: string, run: (ctx: ScanCtx) => Promise<void>): SourcePlugin => ({
  tool: "cursor", id, tier: "P0", beta: false, describe: { reads: [], neverReads: [] },
  locate: () => [{ root: home, home, wsl: false }],
  scan: (_c, ctx) => run(ctx),
});

const copier = plugin("test.copier", async (ctx) => makeCopy(ctx));
const tail = plugin("test.tail", async (ctx) => {
  makeCopy(ctx);
  await turn(); // its last await
  spin(1_500);
});
const overlap = (name: string) => plugin(`test.overlap-${name}`, async (ctx) => {
  makeCopy(ctx, ` ${name}`);
  await work(ctx, 2_000);
  ctx.emit({ k: "coverage", tool: "cursor", source: `test.overlap-${name}`, window: "detail", status: "ok", files: 0, bytes: 0, records: 1, skipped: {}, unknownTypes: {}, versions: [] });
});
const stubborn = plugin("test.stubborn", async (ctx) => {
  makeCopy(ctx);
  await work(ctx, 3_000, true);
});
const lateB: SourcePlugin = {
  ...plugin("test.late-B", async (ctx) => makeCopy(ctx, " B")),
  locate: () => {
    console.log("located B");
    return [{ root: home, home, wsl: false }];
  },
};
const lateA = plugin("test.late-A", async (ctx) => {
  makeCopy(ctx, " A");
  await work(ctx, 5_000); // until the signal aborts it
  console.log("entering B");
  void scan({ env, plugins: [lateB] }).then((r) => console.log(`after-scan B ${JSON.stringify({ status: r.coverage[0]?.status, note: r.coverage[0]?.note })}`));
  await work(ctx, 300, true); // A unwinds while B is inside the trap
});

const ac = new AbortController();
if (mode === "owned") process.on("SIGINT", () => ac.abort());
if (mode === "overlap-listener") process.on("SIGINT", () => console.log("app-listener"));
console.log("ready");
if (mode === "default" || mode === "owned") {
  const r = await scan({ env, plugins: [copier, ccTranscripts], handleSignals: mode !== "owned", signal: ac.signal });
  const own = r.coverage.find((c) => c.source === ccTranscripts.id);
  console.log(`after-scan ${JSON.stringify({ status: own?.status, note: own?.note, records: own?.records, tempClean: r.tempClean })}`);
} else if (mode === "late") {
  const r = await scan({ env, plugins: [lateA] });
  console.log(`after-scan A ${JSON.stringify({ status: r.coverage[0]?.status, tempClean: r.tempClean })}`);
} else if (mode === "overlap" || mode === "overlap-listener") {
  await Promise.all(["A", "B"].map(async (name) => {
    const r = await scan({ env, plugins: [overlap(name)] });
    console.log(`after-scan ${name} ${JSON.stringify({ status: r.coverage[0]?.status, note: r.coverage[0]?.note, tempClean: r.tempClean })}`);
  }));
} else {
  const r = await scan({ env, plugins: [mode === "tail" ? tail : stubborn] });
  console.log(`after-scan ${JSON.stringify({ status: r.coverage[0]?.status, tempClean: r.tempClean })}`);
}
