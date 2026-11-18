import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import path from "node:path";
import type { CoverageEv } from "../../core/model/events";
import { coverageLine } from "../../scripts/smoke-local";
import { buildAntigravity, C as AG_C, I1, I2, K, P } from "../fixtures/antigravity";
import { buildCcLifetime, buildCcTranscripts, CC_H1, CC_H2, CC_S1, CC_S2 } from "../fixtures/claude-code";
import { buildCodexIndex, buildCodexRollouts } from "../fixtures/codex";
import { buildCopilot, S_J, S_L } from "../fixtures/copilot";
import { A, B, buildAgentCli, buildCursor } from "../fixtures/cursor";
import { CANARY, expectNoCanaries } from "../kit/canary";
import { fakeHome, type FakeHome } from "../kit/home";

const SMOKE = path.join(import.meta.dir, "..", "..", "scripts", "smoke-local.ts");
/**
 * The value of every `key=value` token the smoke prints: a number, a ratio, `n/a` or `-`, a boolean, a month span, or a
 * short code. Pinned here; Task 16 extends it.
 */
const VALUE = /^(-?\d+(\.\d+)?|\d+\/\d+|n\/a|-|true|false|\d{4}-\d{2}\.\.\d{4}-\d{2}|-\.\.-|[a-z][a-z0-9_.:-]{0,47})$/;
/** A `key=value` token: a key, which holds no `=`, then `=` and the value, all after it. A `==` heading has no key. */
const KEY_VALUE = /^([^=]+)=(.*)$/;
/** A calendar date: the smoke never prints a date finer than a month. */
const DAY = /\d{4}-\d{2}-\d{2}/;
const skipChmod = process.platform === "win32" || process.getuid?.() === 0;

interface Run { code: number | null; out: string; err: string }

let h: FakeHome;
/** The fixtures' session ids and working directories: the smoke prints none of them. */
let secrets: string[];

/** Every Plan 1 fixture in the home; returns the session ids and working directories they hold. */
function buildAll(): string[] {
  buildCcTranscripts(h);
  buildCcLifetime(h);
  const rollouts = buildCodexRollouts(h);
  const index = buildCodexIndex(h);
  buildCopilot(h);
  buildCursor(h);
  buildAgentCli(h);
  buildAntigravity(h);
  return [
    CC_S1, CC_S2, CC_H1, CC_H2, ...[rollouts.r1, rollouts.r2, rollouts.r3, rollouts.r4].map((r) => r.id), ...Object.values(index.ids),
    S_J, S_L, A, B, P, AG_C, K, I1, I2, CANARY.path, "/work/projB", "/work/projC",
  ];
}

beforeEach(() => {
  h = fakeHome();
  secrets = buildAll();
});
afterEach(() => h.cleanup());

/** Runs the smoke as a child whose every home, config and temp variable points into the fake home: never at this machine. */
async function smoke(...args: string[]): Promise<Run> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: h.env.home, USERPROFILE: h.env.home,
    APPDATA: h.env.appData ?? path.join(h.env.home, "AppData", "Roaming"), LOCALAPPDATA: h.env.localAppData ?? path.join(h.env.home, "AppData", "Local"),
    XDG_CONFIG_HOME: h.env.xdgConfig, XDG_DATA_HOME: h.env.xdgData, XDG_STATE_HOME: h.env.xdgState,
    TMPDIR: h.env.tmp, TEMP: h.env.tmp, TMP: h.env.tmp,
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  const child = Bun.spawn([process.execPath, SMOKE, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}

const lastLine = (out: string): string => out.trimEnd().split("\n").at(-1) ?? "";
/** The `key=value` tokens of a text. */
const keyValues = (text: string): RegExpExecArray[] => text.split(/\s+/).flatMap((t) => {
  const m = KEY_VALUE.exec(t);
  return m ? [m] : [];
});
/** The `key=value` tokens of a text whose value breaks the grammar. */
const offGrammar = (text: string): string[] => keyValues(text).filter((m) => !VALUE.test(m[2]!)).map((m) => m[0]);

/** Counts only: no canary, no line naming the home or a fixture's session id or working directory, no day date, every value in the grammar. */
function expectCountsOnly(r: Run): void {
  const text = r.out + r.err;
  expectNoCanaries(text);
  const named = [h.root, path.basename(h.root), ...secrets];
  expect(text.split("\n").flatMap((line) => named.filter((s) => line.includes(s)).map((s) => `${s} in: ${line}`))).toEqual([]);
  expect(text.split("\n").filter((line) => DAY.test(line))).toEqual([]);
  expect(keyValues(text).length).toBeGreaterThan(0);
  expect(offGrammar(text)).toEqual([]);
}

describe("the local smoke, run on a synthetic home (child process)", () => {
  test("(a) every P0 source present: exit 0, RESULT: PASS last, counts only", async () => {
    const r = await smoke();
    expectCountsOnly(r);
    expect({ code: r.code, last: lastLine(r.out) }).toEqual({ code: 0, last: "RESULT: PASS" });
  }, 90_000);

  test.skipIf(skipChmod)("(b) an unreadable .claude/projects: exit 1, RESULT: FAIL last, counts only", async () => {
    const projects = path.join(h.env.home, ".claude", "projects");
    chmodSync(projects, 0o000);
    try {
      const r = await smoke();
      expectCountsOnly(r);
      expect(r.code).toBe(1);
      expect(lastLine(r.out)).toStartWith("RESULT: FAIL");
    } finally {
      chmodSync(projects, 0o700);
    }
  }, 90_000);

  test("(c) --concurrency x: exit 1, stdout exactly the error's class name", async () => {
    const r = await smoke("--concurrency", "x");
    expect({ code: r.code, out: r.out }).toEqual({ code: 1, out: "error: Error\n" });
  }, 90_000);
});

describe("the smoke's coverage line", () => {
  const cov: CoverageEv = {
    k: "coverage", tool: "codex", source: "codex.config", window: "lifetime", status: "ok", beta: false, files: 1, bytes: 10, records: 2,
    skipped: { "io-error": 1, [CANARY.prompt]: 2 }, unknownTypes: { "(other)": 3 }, versions: [],
  };

  test("a span is two months, or -..- unless both ends are known; a skip reason that is no code prints as other", () => {
    const at = Date.UTC(2026, 0, 15);
    const lines = [coverageLine({ ...cov, from: at, to: at }), coverageLine({ ...cov, from: at }), coverageLine({ ...cov, to: at }), coverageLine(cov)];
    expect(lines.map((l) => l.split(" ").find((t) => t.startsWith("span=")))).toEqual(["span=2026-01..2026-01", "span=-..-", "span=-..-", "span=-..-"]);
    expect(lines[0]).toContain("skipped: io-error=1 other=2");
    expectNoCanaries(lines);
    expect(lines.flatMap(offGrammar)).toEqual([]);
  });
});
