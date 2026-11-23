import { describe, expect, test } from "bun:test";
import os from "node:os";
import { detectEnv } from "../../../core/env/env";
import { GcPacer, holdStreamGc, STREAM_GC } from "../../../core/io/jsonl";
import { scan, type ScanOptions } from "../../../core/scan";
import type { SourcePlugin } from "../../../core/sources/types";

const MiB = 1024 * 1024;
const OPTS = { checkEvery: 8 * MiB, minRss: 384 * MiB, slack: 128 * MiB };

/**
 * A fake process: a live heap that never shrinks, plus garbage that grows as bytes are read and that a collection
 * clears. No real memory and no clock: `rss` and `collect` are the pacer's only view of the process.
 */
function fakeProcess(live: number, garbagePerCheck: number, liveGrowthPerCheck = 0) {
  let garbage = 0;
  let heap = live;
  const atCollect: number[] = []; // the growth over the last collection's RSS, at each collection
  let after = 0;
  const p = {
    rss: () => heap + garbage,
    collect: () => { atCollect.push(heap + garbage - after); garbage = 0; after = heap; },
    read: (pacer: GcPacer, bytes: number) => {
      for (let done = 0; done < bytes; done += OPTS.checkEvery) {
        garbage += garbagePerCheck;
        heap += liveGrowthPerCheck;
        pacer.add(OPTS.checkEvery);
      }
    },
    atCollect,
  };
  return p;
}

describe("GcPacer", () => {
  test("collects about every slack of RSS growth, not every fixed number of bytes read", () => {
    const p = fakeProcess(600 * MiB, 10 * MiB);
    const pacer = new GcPacer(OPTS, p.collect, p.rss);
    p.read(pacer, 1024 * MiB); // 128 checks
    // the first check sets the baseline (610 MiB); the first collection waits for 140 MiB over it (check 14), and each
    // later one for 130 MiB over the RSS its collection left (13 checks of 10 MiB: the first growth past the 128 MiB
    // slack), so 1 + floor((128 - 14) / 13) collections
    expect(pacer.collections).toBe(9);
    expect(p.atCollect.slice(1).every((g) => g === 130 * MiB)).toBe(true);
    // a fixed pacer that collected every 64 MiB read would have collected 16 times
    expect(pacer.collections).toBeLessThan(1024 / 64);
  });

  test("checks RSS once per checkEvery bytes, however the bytes arrive", () => {
    let checks = 0;
    const pacer = new GcPacer(OPTS, () => {}, () => { checks++; return 0; });
    pacer.add(8 * MiB - 1);
    expect(checks).toBe(0);
    pacer.add(1);
    expect(checks).toBe(1);
    pacer.add(30 * MiB); // one check however far past the step, and the count starts again
    expect(checks).toBe(2);
    pacer.add(8 * MiB - 1);
    expect(checks).toBe(2);
  });

  test("never collects below minRss, whatever the growth", () => {
    const p = fakeProcess(100 * MiB, 10 * MiB, 0);
    const pacer = new GcPacer({ ...OPTS, minRss: 2048 * MiB }, p.collect, p.rss);
    p.read(pacer, 1024 * MiB); // RSS climbs to 1380 MiB, still under the floor
    expect(pacer.collections).toBe(0);
  });

  test("enabled = false: no collections", () => {
    const p = fakeProcess(600 * MiB, 10 * MiB);
    const pacer = new GcPacer(OPTS, p.collect, p.rss);
    pacer.enabled = false;
    p.read(pacer, 1024 * MiB);
    expect(pacer.collections).toBe(0);
    expect(p.atCollect).toEqual([]);
  });

  test("a heap that never grows: 0 collections, above the floor too", () => {
    const p = fakeProcess(600 * MiB, 0);
    const pacer = new GcPacer(OPTS, p.collect, p.rss);
    p.read(pacer, 1024 * MiB);
    expect(pacer.collections).toBe(0);
  });

  test("after RSS falls between scans, growth is measured from the low mark, not the stale high one", () => {
    let rss = 600 * MiB;
    let collections = 0;
    const pacer = new GcPacer(OPTS, () => { collections++; rss = 900 * MiB; }, () => rss);
    pacer.add(OPTS.checkEvery); // baseline 600
    rss = 1_000 * MiB;
    pacer.add(OPTS.checkEvery); // 400 over: collects, leaving a 900 MiB baseline
    expect(collections).toBe(1);
    rss = 350 * MiB; // the first scan's store is released and its pages returned
    pacer.add(OPTS.checkEvery); // the baseline drops to 350
    // the next scan grows 10 MiB per check: the first collection comes past 350 + 128 MiB, not past 900 + 128 MiB
    let at = 0;
    while (collections === 1) {
      rss += 10 * MiB;
      at = rss;
      pacer.add(OPTS.checkEvery);
    }
    expect(at).toBe(480 * MiB);
  });

  test("collections is read-only", () => {
    const pacer = new GcPacer(OPTS, () => {}, () => 0);
    expect(() => { (pacer as unknown as { collections: number }).collections = 5; }).toThrow();
    expect(pacer.collections).toBe(0);
  });
});

describe("holdStreamGc", () => {
  test("off disables the shared pacer while held; the last release restores what was there before", () => {
    const before = STREAM_GC.enabled;
    try {
      STREAM_GC.enabled = true;
      const off = holdStreamGc("off");
      expect(STREAM_GC.enabled).toBe(false);
      off();
      expect(STREAM_GC.enabled).toBe(true);

      STREAM_GC.enabled = false; // an application that turned it off itself: an auto hold enables it, then gives it back
      const auto = holdStreamGc("auto");
      expect(STREAM_GC.enabled).toBe(true);
      auto();
      expect(STREAM_GC.enabled).toBe(false);
    } finally {
      STREAM_GC.enabled = before;
    }
  });

  test("overlapping holds: auto wins while any auto hold is held, in either order of release; releases are idempotent", () => {
    const before = STREAM_GC.enabled;
    try {
      STREAM_GC.enabled = true;
      const auto = holdStreamGc("auto");
      const off = holdStreamGc("off");
      expect(STREAM_GC.enabled).toBe(true); // an off scan joining never turns it off under a running auto scan
      off();
      expect(STREAM_GC.enabled).toBe(true);
      off(); // a second release changes nothing
      expect(STREAM_GC.enabled).toBe(true);
      auto();
      expect(STREAM_GC.enabled).toBe(true);

      const off2 = holdStreamGc("off");
      expect(STREAM_GC.enabled).toBe(false);
      const auto2 = holdStreamGc("auto");
      expect(STREAM_GC.enabled).toBe(true); // an auto scan joining turns it on
      auto2(); // the auto scan ends first: off for the off scan still running
      expect(STREAM_GC.enabled).toBe(false);
      auto2();
      expect(STREAM_GC.enabled).toBe(false);
      off2();
      expect(STREAM_GC.enabled).toBe(true);

      const off3 = holdStreamGc("off");
      const off4 = holdStreamGc("off");
      expect(STREAM_GC.enabled).toBe(false); // every hold asked for off
      off3();
      expect(STREAM_GC.enabled).toBe(false);
      off4();
      expect(STREAM_GC.enabled).toBe(true);
    } finally {
      STREAM_GC.enabled = before;
    }
  });
});

describe("scan gc option", () => {
  const env = detectEnv({ home: os.tmpdir(), tmp: os.tmpdir(), platform: "linux", wslHomes: [] });

  /** A plugin that records the shared pacer's state when it starts, then waits for `go` before it finishes. */
  function gated(id: string) {
    let release!: () => void;
    const go = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const running = new Promise<void>((r) => { started = r; });
    const seen: boolean[] = [];
    const plugin: SourcePlugin = {
      tool: "codex", id, tier: "P0", beta: false, describe: { reads: [], neverReads: [] },
      locate: () => [{ root: env.home, home: env.home, wsl: false }],
      scan: async (_c, ctx) => {
        seen.push(STREAM_GC.enabled);
        started();
        await go;
        seen.push(STREAM_GC.enabled);
        ctx.emit({ k: "coverage", tool: "codex", source: id, window: "detail", status: "empty", files: 0, bytes: 0, records: 0,
          skipped: {}, unknownTypes: {}, versions: [] });
      },
    };
    return { plugin, release, running, seen };
  }
  const run = (p: SourcePlugin, o: Partial<ScanOptions> = {}) =>
    scan({ env, plugins: [p], handleSignals: false, repoSignals: false, ...o });

  test("two overlapping scans: an auto scan keeps the pacer on however they end; an off scan alone has it off", async () => {
    const before = STREAM_GC.enabled;
    try {
      STREAM_GC.enabled = true;
      // auto starts, off joins, off ends first
      const a = gated("auto-a");
      const b = gated("off-b");
      const ra = run(a.plugin);
      await a.running;
      const rb = run(b.plugin, { gc: "off" });
      await b.running;
      expect(STREAM_GC.enabled).toBe(true);
      b.release();
      await rb;
      expect(STREAM_GC.enabled).toBe(true); // the auto scan is still running
      a.release();
      await ra;
      expect(STREAM_GC.enabled).toBe(true);
      expect(a.seen).toEqual([true, true]);
      expect(b.seen).toEqual([true, true]);

      // off starts, auto joins, auto ends first
      const c = gated("off-c");
      const d = gated("auto-d");
      const rc = run(c.plugin, { gc: "off" });
      await c.running;
      expect(STREAM_GC.enabled).toBe(false);
      const rd = run(d.plugin, { gc: "auto" });
      await d.running;
      expect(STREAM_GC.enabled).toBe(true);
      d.release();
      await rd;
      expect(STREAM_GC.enabled).toBe(false); // only the off scan is still running
      c.release();
      await rc;
      expect(STREAM_GC.enabled).toBe(true);
      expect(c.seen).toEqual([false, false]);
      expect(d.seen).toEqual([true, true]);
    } finally {
      STREAM_GC.enabled = before;
    }
  });

  test("one scan logs scan.gc exactly once, at debug, with a non-negative integer", async () => {
    const a = gated("log-once");
    a.release();
    const logs: [string, string, number | undefined][] = [];
    await run(a.plugin, { onLog: (level, code, n) => { logs.push([level, code, n]); } });
    const gc = logs.filter(([, code]) => code === "scan.gc");
    expect(gc).toHaveLength(1);
    const [level, , n] = gc[0]!;
    expect(level).toBe("debug");
    expect(Number.isInteger(n) && n! >= 0).toBe(true);
  });

  test("the logged scan.gc value is the number of collections the scan's reading caused", async () => {
    // STREAM_GC with a fake memory reading and collector, and a fresh byte count and baseline; all restored afterwards
    const pacer = STREAM_GC as unknown as { rss: () => number; collect: () => void; bytes: number; baseline: number | undefined };
    const saved = { rss: pacer.rss, collect: pacer.collect, bytes: pacer.bytes, baseline: pacer.baseline, enabled: STREAM_GC.enabled };
    let rss = 400 * MiB;
    pacer.rss = () => rss;
    pacer.collect = () => { rss = 450 * MiB; };
    pacer.bytes = 0;
    pacer.baseline = undefined;
    try {
      const plugin: SourcePlugin = {
        tool: "codex", id: "reads", tier: "P0", beta: false, describe: { reads: [], neverReads: [] },
        locate: () => [{ root: env.home, home: env.home, wsl: false }],
        scan: async (_c, ctx) => {
          STREAM_GC.add(OPTS.checkEvery); // first look: the baseline, 400 MiB
          rss = 600 * MiB;
          STREAM_GC.add(OPTS.checkEvery); // 200 MiB over it: one collection, which leaves 450 MiB
          STREAM_GC.add(OPTS.checkEvery); // no growth since: none
          STREAM_GC.add(OPTS.checkEvery);
          ctx.emit({ k: "coverage", tool: "codex", source: "reads", window: "detail", status: "empty", files: 0, bytes: 0, records: 0,
            skipped: {}, unknownTypes: {}, versions: [] });
        },
      };
      const logs: [string, string, number | undefined][] = [];
      await run(plugin, { onLog: (level, code, n) => { logs.push([level, code, n]); } });
      expect(logs.filter(([, code]) => code === "scan.gc")).toEqual([["debug", "scan.gc", 1]]);
    } finally {
      Object.assign(pacer, { rss: saved.rss, collect: saved.collect, bytes: saved.bytes, baseline: saved.baseline });
      STREAM_GC.enabled = saved.enabled;
    }
  });

  test("a scan restores the pacer state when it ends, and logs its collections as scan.gc", async () => {
    const before = STREAM_GC.enabled;
    try {
      STREAM_GC.enabled = false;
      const a = gated("auto-log");
      a.release();
      const logs: [string, string, number | undefined][] = [];
      await run(a.plugin, { onLog: (level, code, n) => { logs.push([level, code, n]); } });
      expect(a.seen).toEqual([true, true]);
      expect(STREAM_GC.enabled).toBe(false);
      const gc = logs.filter(([, code]) => code === "scan.gc");
      expect(gc).toHaveLength(1);
      expect(gc[0]![0]).toBe("debug");
      expect(Number.isInteger(gc[0]![2]) && gc[0]![2]! >= 0).toBe(true);
    } finally {
      STREAM_GC.enabled = before;
    }
  });
});
