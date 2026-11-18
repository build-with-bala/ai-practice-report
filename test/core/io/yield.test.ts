import { describe, expect, test } from "bun:test";
import os from "node:os";
import { detectEnv } from "../../../core/env/env";
import { readJsonlStream } from "../../../core/io/jsonl";
import { maybeYield, SLICE_MS } from "../../../core/io/yield";
import { scan } from "../../../core/scan";
import type { Candidate, SourcePlugin } from "../../../core/sources/types";

const enc = new TextEncoder();
const LINE = enc.encode(`${JSON.stringify({ type: "user", text: "x".repeat(200) })}\n`.repeat(256));

/** An endless in-memory JSONL stream: every read resolves at once, so only an explicit yield lets the event loop run. */
const endless = (): ReadableStream<Uint8Array> => new ReadableStream({ pull: (c) => c.enqueue(LINE) });

const busy = (ms: number): void => {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* CPU work that never awaits */ }
};

describe("maybeYield", () => {
  test("costs nothing within the slice, and takes one event-loop turn after it", async () => {
    const first = maybeYield();
    if (first) await first;
    expect(maybeYield()).toBeUndefined();
    busy(SLICE_MS + 5);
    let immediate = false;
    setImmediate(() => { immediate = true; });
    const pause = maybeYield();
    expect(pause).toBeInstanceOf(Promise);
    await pause;
    expect(immediate).toBe(true);
  });

  test("a long JSONL stream lets timers fire while it is read", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      const end = performance.now() + 300;
      let lines = 0;
      for await (const _ of readJsonlStream(endless())) {
        lines++;
        if (performance.now() > end) break;
      }
      expect(lines).toBeGreaterThan(1000);
      expect(ticks).toBeGreaterThanOrEqual(3);
    } finally {
      clearInterval(timer);
    }
  });

  test("an abort fired by a timer ends a stream that never awaits I/O", async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 50);
    const started = performance.now();
    let lines = 0;
    try {
      for await (const _ of readJsonlStream(endless(), { signal: ac.signal })) lines++;
    } finally {
      clearTimeout(timer);
    }
    expect(lines).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("the orchestrator lets the event loop run between plugins that never await", async () => {
    const order: string[] = [];
    const sync = (id: string): SourcePlugin => ({
      tool: "codex", id, tier: "P0", beta: false, describe: { reads: [], neverReads: [] },
      locate: (): Candidate[] => [{ root: os.tmpdir(), home: os.tmpdir(), wsl: false }],
      scan: async () => { busy(SLICE_MS + 10); order.push(id); },
    });
    setTimeout(() => order.push("timer"), 0);
    await scan({ env: detectEnv({ tmp: os.tmpdir(), wslHomes: [] }), plugins: [sync("a"), sync("b"), sync("c")], concurrency: 1 });
    expect(order).toContain("timer"); // it ran during the scan, not after it
    expect(order.indexOf("timer")).toBeLessThan(order.indexOf("c"));
  });
});
