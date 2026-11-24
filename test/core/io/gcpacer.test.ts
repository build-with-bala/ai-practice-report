import { afterAll, describe, expect, test } from "bun:test";
import os from "node:os";
import { fakeHome } from "../../kit/home";
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

/**
 * A fake process whose allocator keeps pages: RSS is the high-water mark of live heap plus garbage, and a collection
 * clears the garbage but hands back only `handBack` (0 to 1) of what it freed.
 */
function keepingProcess(live: number, garbagePerCheck: number, handBack: number) {
  let garbage = 0;
  let mark = live;
  const p = {
    peak: live,
    rss: () => (mark = Math.max(mark, live + garbage)),
    collect: () => { mark = Math.max(live, mark - garbage * handBack); garbage = 0; },
    read: (pacer: GcPacer, bytes: number) => {
      for (let done = 0; done < bytes; done += OPTS.checkEvery) {
        garbage += garbagePerCheck;
        pacer.add(OPTS.checkEvery);
        p.peak = Math.max(p.peak, mark);
      }
    },
  };
  return p;
}

describe("GcPacer fallback: an allocator that keeps its pages", () => {
  test("RSS never falls after a collection: the pacer keeps collecting every fallbackEvery bytes, and the peak stays put", () => {
    const p = keepingProcess(600 * MiB, 10 * MiB, 0);
    const pacer = new GcPacer({ ...OPTS, fallbackEvery: 64 * MiB }, p.collect, p.rss);
    p.read(pacer, 4096 * MiB); // 512 checks
    // check 14 (740 MiB, 130 over the 610 baseline) collects and RSS stays at 740: from then on every 8th check (64 MiB)
    // collects, with 80 MiB of garbage, which the kept pages hold: 1 + floor((512 - 14) / 8)
    expect(pacer.collections).toBe(63);
    expect(p.peak).toBe(740 * MiB);
  });

  test("the default fallback step is 16 MiB: every second check", () => {
    const p = keepingProcess(600 * MiB, 10 * MiB, 0);
    const pacer = new GcPacer(OPTS, p.collect, p.rss);
    p.read(pacer, 4096 * MiB);
    expect(pacer.collections).toBe(1 + Math.floor((512 - 14) / 2));
    expect(p.peak).toBe(740 * MiB);
  });

  test("the adaptive rule alone ratchets there: the fallback is what holds the peak", () => {
    const p = keepingProcess(600 * MiB, 10 * MiB, 0);
    const pacer = new GcPacer({ ...OPTS, fallbackEvery: Number.MAX_SAFE_INTEGER }, p.collect, p.rss);
    p.read(pacer, 4096 * MiB);
    expect(p.peak).toBeGreaterThan(1536 * MiB); // up by about one slack per collection, collection after collection
    expect(pacer.collections).toBeLessThan(20);
  });

  test("RSS falls only partly: the pacer keeps collecting often, and the peak stays within one slack of the first", () => {
    for (const handBack of [0.1, 0.25, 0.4]) {
      const p = keepingProcess(600 * MiB, 10 * MiB, handBack);
      const pacer = new GcPacer(OPTS, p.collect, p.rss);
      p.read(pacer, 4096 * MiB);
      expect([handBack, pacer.collections >= 4096 / 64 / 2]).toEqual([handBack, true]);
      expect([handBack, p.peak <= 740 * MiB]).toEqual([handBack, true]);
    }
  });

  test("collections that hand back at least half of what they answered: the adaptive rule alone", () => {
    const p = keepingProcess(600 * MiB, 10 * MiB, 0.6);
    const pacer = new GcPacer(OPTS, p.collect, p.rss);
    p.read(pacer, 4096 * MiB);
    // RSS tracks live memory well enough: the adaptive rule alone, about once per slack of growth
    expect(pacer.collections).toBeLessThan(4096 / 64 / 2);
    expect(p.peak).toBeLessThanOrEqual(600 * MiB + 2 * 128 * MiB);
  });

  test("the fallback stays on after a later fall, and ends once RSS is back at minRss", () => {
    let rss = 600 * MiB;
    let collections = 0;
    let fall = 0; // what the next collection hands back
    const pacer = new GcPacer({ ...OPTS, fallbackEvery: 64 * MiB }, () => { collections++; rss -= fall; }, () => rss);
    const step = (to: number) => { rss = to; pacer.add(OPTS.checkEvery); };
    step(600 * MiB); // baseline
    step(800 * MiB); // 200 over: collects, RSS stays: the fallback starts
    expect(collections).toBe(1);
    for (let i = 0; i < 8; i++) step(800 * MiB); // 64 MiB since: the fallback collects
    expect(collections).toBe(2);
    fall = 200 * MiB;
    for (let i = 0; i < 8; i++) step(rss); // a collection that falls all the way: the fallback stays on
    expect(collections).toBe(3);
    fall = 0;
    for (let i = 0; i < 8; i++) step(rss);
    expect(collections).toBe(4);
    step(300 * MiB); // back at the floor: the fallback ends
    for (let i = 0; i < 16; i++) step(420 * MiB); // above the floor, under the slack over 300: nothing
    expect(collections).toBe(4);
  });

  test("below minRss the fallback never collects", () => {
    const p = keepingProcess(100 * MiB, 1 * MiB, 0);
    const pacer = new GcPacer({ ...OPTS, minRss: 2048 * MiB }, p.collect, p.rss);
    p.read(pacer, 4096 * MiB);
    expect(pacer.collections).toBe(0);
  });
});

describe("GcPacer.settle", () => {
  test("collects once above minRss, never below it or when disabled; the next growth is measured from after it", () => {
    let rss = 300 * MiB;
    let collections = 0;
    const pacer = new GcPacer(OPTS, () => { collections++; rss = 450 * MiB; }, () => rss);
    pacer.settle();
    expect(collections).toBe(0);
    rss = 500 * MiB;
    pacer.enabled = false;
    pacer.settle();
    expect(collections).toBe(0);
    pacer.enabled = true;
    pacer.settle();
    expect([collections, pacer.collections]).toEqual([1, 1]);
    rss = 570 * MiB;
    pacer.add(OPTS.checkEvery); // 120 over the 450 it left: nothing
    expect(collections).toBe(1);
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
  const h = fakeHome("linux");
  afterAll(() => h.cleanup());
  const env = h.env;

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
          rss = 300 * MiB; // the scan ends under the floor: no settling collection
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

  test("a scan that ends above the floor settles with one collection, counted in scan.gc", async () => {
    const pacer = STREAM_GC as unknown as { rss: () => number; collect: () => void; bytes: number; baseline: number | undefined };
    const saved = { rss: pacer.rss, collect: pacer.collect, bytes: pacer.bytes, baseline: pacer.baseline, enabled: STREAM_GC.enabled };
    let collected = 0;
    pacer.rss = () => 500 * MiB;
    pacer.collect = () => { collected++; };
    try {
      const quiet = gated("settle");
      quiet.release();
      const logs: [string, string, number | undefined][] = [];
      await run(quiet.plugin, { onLog: (level, code, n) => { logs.push([level, code, n]); } });
      expect(collected).toBe(1);
      expect(logs.filter(([, code]) => code === "scan.gc")).toEqual([["debug", "scan.gc", 1]]);
      const off = gated("settle-off");
      off.release();
      await run(off.plugin, { gc: "off" });
      expect(collected).toBe(1); // a scan with the pacer off never settles
    } finally {
      Object.assign(pacer, { rss: saved.rss, collect: saved.collect, bytes: saved.bytes, baseline: saved.baseline });
      STREAM_GC.enabled = saved.enabled;
    }
  });

  test("two scans in a row: the second starts on the adaptive rule, not the first scan's fallback", async () => {
    const pacer = STREAM_GC as unknown as { rss: () => number; collect: () => void; bytes: number; baseline: number | undefined; sinceCollect: number };
    const saved = { rss: pacer.rss, collect: pacer.collect, bytes: pacer.bytes, baseline: pacer.baseline, sinceCollect: pacer.sinceCollect, enabled: STREAM_GC.enabled };
    let rss = 400 * MiB;
    pacer.rss = () => rss;
    pacer.collect = () => {}; // RSS never falls
    pacer.bytes = 0;
    pacer.baseline = undefined;
    const reading = (id: string, body: () => void): SourcePlugin => ({
      tool: "codex", id, tier: "P0", beta: false, describe: { reads: [], neverReads: [] },
      locate: () => [{ root: env.home, home: env.home, wsl: false }],
      scan: async (_c, ctx) => {
        body();
        ctx.emit({ k: "coverage", tool: "codex", source: id, window: "detail", status: "empty", files: 0, bytes: 0, records: 0,
          skipped: {}, unknownTypes: {}, versions: [] });
      },
    });
    const gcOf = async (p: SourcePlugin): Promise<number | undefined> => {
      let n: number | undefined;
      await run(p, { onLog: (_l, code, v) => { if (code === "scan.gc") n = v; } });
      return n;
    };
    try {
      const first = await gcOf(reading("first", () => {
        STREAM_GC.add(OPTS.checkEvery); // the baseline, 400 MiB
        rss = 600 * MiB;
        STREAM_GC.add(OPTS.checkEvery); // 200 over: collects; RSS stays: the fallback starts
        for (let i = 0; i < 8; i++) STREAM_GC.add(OPTS.checkEvery); // 64 MiB: a fallback collection every 16 MiB
      }));
      expect(first).toBe(1 + 4 + 1); // the slack collection, 4 fallback ones, the settling one
      // RSS is still 600 MiB (never under the floor): only the new scan's start ends the fallback
      const second = await gcOf(reading("second", () => {
        for (let i = 0; i < 8; i++) STREAM_GC.add(OPTS.checkEvery); // flat RSS: the adaptive rule collects nothing
      }));
      expect(second).toBe(1); // the settling collection only
    } finally {
      Object.assign(pacer, { rss: saved.rss, collect: saved.collect, bytes: saved.bytes, baseline: saved.baseline, sinceCollect: saved.sinceCollect });
      STREAM_GC.enabled = saved.enabled;
      STREAM_GC.newPhase();
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
