// Spawned by test/core/scan.signals.test.ts. Scans a synthetic home with the Claude Code transcripts reader plus a
// plugin that makes a private temp dir (as a busy store's copy does), and prints markers: `ready` just before scan(),
// `copied` once the temp dir exists, and `after-scan …` once scan() returned — which must never print when a trapped
// signal ended the scan.
//   bun test/kit/scan-child.ts <home> <tmp> <default|owned>
//   default: the core's signal policy; owned: the application traps SIGINT itself and aborts the scan (handleSignals false)
import { writeFileSync } from "node:fs";
import path from "node:path";
import { detectEnv } from "../../core/env/env";
import { scan } from "../../core/scan";
import { ccTranscripts } from "../../core/sources/claude-code";
import type { SourcePlugin } from "../../core/sources/types";

const [home, tmp, mode] = process.argv.slice(2) as [string, string, "default" | "owned"];
const env = detectEnv({ home, tmp, vars: {}, wslHomes: [] });

const copier: SourcePlugin = {
  tool: "cursor", id: "test.copier", tier: "P0", beta: false, describe: { reads: [], neverReads: [] },
  locate: () => [{ root: home, home, wsl: false }],
  scan: async (_c, ctx) => {
    writeFileSync(path.join(ctx.temp.dir(), "copy.db"), "x");
    console.log("copied");
  },
};

const ac = new AbortController();
if (mode === "owned") process.on("SIGINT", () => ac.abort());
console.log("ready");
const r = await scan({ env, plugins: [copier, ccTranscripts], handleSignals: mode !== "owned", signal: ac.signal });
const own = r.coverage.find((c) => c.source === ccTranscripts.id);
console.log(`after-scan ${JSON.stringify({ status: own?.status, note: own?.note, records: own?.records, tempClean: r.tempClean })}`);
