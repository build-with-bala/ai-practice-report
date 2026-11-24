import { describe, expect, test } from "bun:test";
import path from "node:path";

/*
 * The analysis memory budget at scale (global constraint: analysis keeps per-session sufficient statistics, never
 * per-event copies): the live heap `analyze` adds and keeps, against the live heap of the store itself. How it is read
 * is in test/kit/scale-child.ts. Each reading is taken in a child process of its own: in the test runner's process,
 * garbage other test files left could be collected between two readings and make a delta negative.
 */

const CHILD = path.join(import.meta.dir, "..", "kit", "scale-child.ts");

interface Reading { store: number; retained: number; ms: number; bytes: number }

async function measure(events: number): Promise<Reading> {
  const child = Bun.spawn([process.execPath, CHILD, String(events)], { stdout: "pipe", stderr: "inherit" });
  const out = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  return JSON.parse(out.trim().split("\n").at(-1)!) as Reading;
}

/** The wall-clock bound: a runaway guard only, the same everywhere, since a slow or busy machine must never fail it. */
const RUNAWAY_MS = 30_000;

/**
 * The readings are real: the store costs a plausible number of bytes per event (about 150 here), so a denominator
 * inflated by garbage a collection left behind, or deflated by a missed one, fails instead of passing silently. The
 * retained delta is bounded above only: a collector that hands memory back between the two readings can make it zero
 * or negative, and that is no leak.
 */
function sane(m: Reading, events: number): void {
  expect(Number.isFinite(m.retained)).toBe(true);
  expect(m.store / events).toBeGreaterThanOrEqual(50);
  expect(m.store / events).toBeLessThanOrEqual(500);
}

describe("scale", () => {
  test("300,000 events: analyze keeps at most 25% of the store's heap, ends within the runaway guard, exports at most 300 KB", async () => {
    const m = await measure(300_000);
    sane(m, 300_000);
    expect(m.retained / m.store).toBeLessThanOrEqual(0.25);
    expect(m.ms).toBeLessThanOrEqual(RUNAWAY_MS);
    expect(m.bytes).toBeLessThanOrEqual(300_000);
  }, 120_000);

  test.skipIf(process.env.SLOW !== "1")("SLOW=1, 3,000,000 events: the same 25%, within 30 s", async () => {
    const m = await measure(3_000_000);
    sane(m, 3_000_000);
    expect(m.retained / m.store).toBeLessThanOrEqual(0.25);
    expect(m.ms).toBeLessThanOrEqual(RUNAWAY_MS);
    expect(m.bytes).toBeLessThanOrEqual(300_000);
  }, 600_000);
});
