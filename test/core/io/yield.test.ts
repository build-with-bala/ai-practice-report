import { describe, expect, test } from "bun:test";
import os from "node:os";
import { fakeHome } from "../../kit/home";
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

/**
 * Runs `f` with `performance.now` replaced by a clock the test moves (`clock.t`), so the slice is decided by the test,
 * not by how fast the runner happens to be; the real clock is restored afterwards.
 */
async function withClock(f: (clock: { t: number }) => Promise<void>): Promise<void> {
  const real = performance.now;
  const clock = { t: real.call(performance) };
  performance.now = () => clock.t;
  try {
    await f(clock);
  } finally {
    performance.now = real;
  }
}

describe("maybeYield", () => {
  test("costs nothing within the slice, and takes one event-loop turn after it", async () => {
    await withClock(async (clock) => {
      clock.t += SLICE_MS; // whatever ran before, the slice is used up: the first call starts a new one
      const first = maybeYield();
      expect(first).toBeInstanceOf(Promise);
      await first;
      clock.t += SLICE_MS - 1;
      expect(maybeYield()).toBeUndefined();
      clock.t += 1;
      let immediate = false;
      setImmediate(() => { immediate = true; });
      const pause = maybeYield();
      expect(pause).toBeInstanceOf(Promise);
      await pause;
      expect(immediate).toBe(true); // a callback queued before the pause ran before the pause resolved
    });
  });

  test("a long JSONL stream lets timers fire while it is read", async () => {
    // Ordering only, never wall-clock: read until the timer has fired 3 times. A reader that never gave the event loop a
    // turn would read all MAX_LINES lines with no tick.
    const MAX_LINES = 5_000_000;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      let lines = 0;
      for await (const _ of readJsonlStream(endless())) {
        lines++;
        if (ticks >= 3 || lines >= MAX_LINES) break;
      }
      expect(ticks).toBeGreaterThanOrEqual(3);
      expect(lines).toBeGreaterThan(0);
      expect(lines).toBeLessThan(MAX_LINES);
    } finally {
      clearInterval(timer);
    }
  });

  test("an abort fired by a timer ends a stream that never awaits I/O", async () => {
    // A line cap, as above, only bounds the failing case: a stream that never let the timer run ends at the cap, before
    // the abort, and fails the order check instead of hanging.
    const MAX_LINES = 5_000_000;
    const ac = new AbortController();
    const order: string[] = [];
    const timer = setTimeout(() => { order.push("abort"); ac.abort(); }, 50);
    let lines = 0;
    try {
      for await (const _ of readJsonlStream(endless(), { signal: ac.signal })) {
        if (++lines >= MAX_LINES) break;
      }
      order.push("ended");
    } finally {
      clearTimeout(timer);
    }
    expect(lines).toBeGreaterThan(0);
    expect(order).toEqual(["abort", "ended"]); // the stream ended because of the abort, after it fired
  });

  test("the orchestrator lets the event loop run between plugins that never await", async () => {
    const order: string[] = [];
    const sync = (id: string): SourcePlugin => ({
      tool: "codex", id, tier: "P0", beta: false, describe: { reads: [], neverReads: [] },
      locate: (): Candidate[] => [{ root: os.tmpdir(), home: os.tmpdir(), wsl: false }],
      scan: async () => { busy(SLICE_MS + 10); order.push(id); },
    });
    setTimeout(() => order.push("timer"), 0);
    const h = fakeHome();
    try {
      await scan({ env: h.env, plugins: [sync("a"), sync("b"), sync("c")], concurrency: 1 });
    } finally {
      h.cleanup();
    }
    expect(order).toContain("timer"); // it ran during the scan, not after it
    expect(order.indexOf("timer")).toBeLessThan(order.indexOf("c"));
  });
});
