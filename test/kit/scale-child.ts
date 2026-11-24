import { heapStats } from "bun:jsc";
import { analyze, type Analysis } from "../../core/analyze";
import { exportPayload } from "../../core/privacy/export";
import type { Ev } from "../../core/model/events";
import type { ScanResult } from "../../core/scan";
import { synthStore } from "./synth";

// Spawned by test/core/scale.test.ts: measures in a process of its own, so no garbage another test file left behind
// is collected between two readings, then prints one JSON line.
//   bun test/kit/scale-child.ts <events>
/*
 * The analysis memory budget at scale (global constraint: analysis keeps per-session sufficient statistics, never
 * per-event copies). What the 25% compares: the live heap `analyze` adds and keeps — its result, held, plus anything it
 * leaves attached to the store, such as the store's lazily built per-session index — against the live heap of the
 * store itself. Both are deltas of the post-collection heap size: before the store, after the store, after `analyze`.
 *
 * Measuring it honestly:
 * - The heap is read as `heapStats().heapSize` after a full collection. `process.memoryUsage().heapUsed` does not follow
 *   a full collection reliably in Bun (it stays flat while a multi-MiB index is built, then jumps by more than analyze
 *   keeps), so it can't separate the two deltas.
 * - The synthetic store builds ids with template literals, which JSC keeps as ropes until first hashed. A reader's
 *   `JSON.parse` leaves flat strings, so the test flattens every string of the store before reading its size; otherwise
 *   analyze's first use of each id would shrink the store and the delta would be meaningless.
 * - A warm-up run on a small store comes first, so compiled code and one-time tables are not counted as retention.
 * - JSC scans stacks and registers conservatively: a stale slot can keep analyze's last session table alive after it
 *   returns. Each reading follows two turns of the event loop, and a tiny analyze run after the measured one overwrites
 *   those slots. The result stays reachable through `held` until the last reading.
 */

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
async function liveHeap(): Promise<number> {
  await tick();
  Bun.gc(true);
  await tick();
  Bun.gc(true);
  return heapStats().heapSize;
}

function flatten(raw: ScanResult): void {
  const seen = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") seen.add(v);
    else if (v !== null && typeof v === "object") for (const x of Object.values(v)) walk(x);
  };
  // every kind the store holds, so a new kind's strings are flattened too and never shrink the store under analyze
  for (const k of Object.keys(raw.store.count()) as Array<Ev["k"]>) for (const e of raw.store.all(k)) walk(e);
  walk(raw.repos.repos);
}

const opts = (raw: ScanResult) => ({ now: raw.finishedAt, timeZone: "UTC" });

/** Store heap, retained heap, the analyze time and the export size for a synthetic store of `events` events. */
async function measure(events: number): Promise<{ store: number; retained: number; ms: number; bytes: number }> {
  const held: { raw?: ScanResult; a?: Analysis } = {};
  const warm = synthStore(20_000);
  analyze(warm, opts(warm));
  const h0 = await liveHeap();
  (() => {
    held.raw = synthStore(events);
    flatten(held.raw);
  })();
  const h1 = await liveHeap();
  let ms = 0;
  (() => {
    const t = performance.now();
    held.a = analyze(held.raw!, opts(held.raw!));
    ms = performance.now() - t;
    const tiny = synthStore(1_000);
    analyze(tiny, opts(tiny));
  })();
  const h2 = await liveHeap();
  const { bytes } = exportPayload(held.a!, { schema: "aiprof/2" });
  if (held.a!.meta.now !== held.raw!.finishedAt) throw new Error("the result was not held to the last reading");
  return { store: h1 - h0, retained: h2 - h1, ms, bytes };
}

const events = Number(process.argv[2]);
console.log(JSON.stringify(await measure(events)));
