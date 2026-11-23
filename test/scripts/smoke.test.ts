import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import path from "node:path";
import { analyze } from "../../core/analyze";
import type { CoverageEv } from "../../core/model/events";
import { analysisLines, coverageLine, exportOf } from "../../scripts/smoke-local";
import { buildAntigravity, C as AG_C, I1, I2, K, P } from "../fixtures/antigravity";
import { buildCcLifetime, buildCcTranscripts, CC_H1, CC_H2, CC_S1, CC_S2, CcTranscript, ccSid, fixtureStart, slug } from "../fixtures/claude-code";
import { buildCodexIndex, buildCodexRollouts } from "../fixtures/codex";
import { buildCopilot, S_J, S_L } from "../fixtures/copilot";
import { A, B, buildAgentCli, buildCursor } from "../fixtures/cursor";
import { personaScan } from "../fixtures/personas";
import { makeRepo } from "../fixtures/repos";
import { CANARY, expectNoCanaries } from "../kit/canary";
import { fakeHome, type FakeHome } from "../kit/home";

const SMOKE = path.join(import.meta.dir, "..", "..", "scripts", "smoke-local.ts");
/**
 * The value of every `key=value` token the smoke prints: a number, a ratio, `n/a` or `-`, a boolean, a month span, or a
 * short code, or (Task 16) a check's `PASS` or `FAIL`.
 */
const VALUE = /^(-?\d+(\.\d+)?|\d+\/\d+|n\/a|-|true|false|PASS|FAIL|\d{4}-\d{2}\.\.\d{4}-\d{2}|-\.\.-|[a-z][a-z0-9_.:-]{0,47})$/;
/** A `key=value` token: a key, which holds no `=`, then `=` and the value, all after it. */
const KEY_VALUE = /^([^=]+)=(.*)$/;
/** A heading rule (`==`): a token made only of `=`, which is no `key=value` token. */
const RULE = /^=+$/;
/** A calendar date: the smoke never prints a date finer than a month. */
const DAY = /\d{4}-\d{2}-\d{2}/;
/** The epoch-millisecond range of an integer (1e12 up to 1e13, so 2001 to 2286): a time finer than a month. */
const EPOCH_MS_MIN = 1e12;
const EPOCH_MS_MAX = 1e13;
/** The analysis lines the smoke prints (Task 16), each a check that passes on a clean synthetic home. */
const ANALYSIS_CHECKS = ["not-saturated", "metrics-have-window-and-n", "export-no-raw-paths", "export-under-300kb", "forensics-ran"];
const skipChmod = process.platform === "win32" || process.getuid?.() === 0;

interface Run { code: number | null; out: string; err: string }

let h: FakeHome;
/** The fixtures' session ids, working directories and repo root: the smoke prints none of them. */
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
  // a real git repo with a Claude Code session working inside it, so repo signals find one repo
  const root = makeRepo(path.join(h.env.home, "code", "smoke-repo"), [
    { files: { "CLAUDE.md": "Run `npm test`.\n", "src/a.ts": "export const a = 1;\n" }, message: "init", at: Date.now() - 3 * 86_400_000 },
  ]);
  const sid = ccSid("SMOKE");
  h.writeJsonl(`.claude/projects/${slug(root)}/${sid}.jsonl`,
    new CcTranscript(sid, { cwd: root, start: fixtureStart(2) }).prompt("Fix the importer").tool("toolu_smoke", "Bash", { command: "npm test" }, { content: "ok" }).records);
  return [
    CC_S1, CC_S2, CC_H1, CC_H2, ...[rollouts.r1, rollouts.r2, rollouts.r3, rollouts.r4].map((r) => r.id), ...Object.values(index.ids),
    S_J, S_L, A, B, P, AG_C, K, I1, I2, CANARY.path, "/work/projB", "/work/projC", sid, root,
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
/**
 * The tokens of a text that break the grammar: every token holding `=` but a heading rule must be a `key=value` token
 * (so one that starts with `=` breaks it) whose value is in the grammar.
 */
const offGrammar = (text: string): string[] => text.split(/\s+/).filter((t) => t.includes("=") && !RULE.test(t)).filter((t) => {
  const m = KEY_VALUE.exec(t);
  return !m || !VALUE.test(m[2]!);
});
/** The integers of a text (a number's integer part) in the epoch-millisecond range: none may be printed. */
const epochMs = (text: string): string[] => (text.match(/\d+(\.\d+)?/g) ?? []).filter((x) => {
  const n = Number(x.split(".")[0]);
  return n >= EPOCH_MS_MIN && n < EPOCH_MS_MAX;
});
/** The value of each `key=` token among `lines`, by key. */
const valuesOf = (lines: string[]): Record<string, string> => Object.fromEntries(keyValues(lines.join("\n")).map((m) => [m[1]!, m[2]!]));

/** Counts only: no canary, no line naming the home or a fixture's session id or working directory, no day date, every value in the grammar. */
function expectCountsOnly(r: Run): void {
  const text = r.out + r.err;
  expectNoCanaries(text);
  const named = [h.root, path.basename(h.root), ...secrets];
  expect(text.split("\n").flatMap((line) => named.filter((s) => line.includes(s)).map((s) => `${s} in: ${line}`))).toEqual([]);
  expect(text.split("\n").filter((line) => DAY.test(line))).toEqual([]);
  expect(epochMs(text)).toEqual([]);
  expect(keyValues(text).length).toBeGreaterThan(0);
  expect(offGrammar(text)).toEqual([]);
}

describe("the local smoke, run on a synthetic home (child process)", () => {
  test("(a) every P0 source present: exit 0, RESULT: PASS last, counts only", async () => {
    const r = await smoke();
    expectCountsOnly(r);
    expect({ code: r.code, last: lastLine(r.out) }).toEqual({ code: 0, last: "RESULT: PASS" });
    // the analysis lines: every check passes, and the counts are in their forms
    const lines = r.out.split("\n");
    const v = valuesOf(lines);
    expect(ANALYSIS_CHECKS.map((k) => [k, v[k]])).toEqual(ANALYSIS_CHECKS.map((k) => [k, "PASS"]));
    expect(lines.filter((l) => /^analysis elapsed=\d+\.\d$/.test(l)).length).toBe(1);
    expect(lines.filter((l) => /^dimensions scored=[0-7]\/7$/.test(l)).length).toBe(1);
    expect(lines).toContain("repo-signals=ok repos=1");
    expect(lines.filter((l) => l.startsWith("export-violations="))).toEqual([]);
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

describe("the smoke's analysis lines (in process)", () => {
  const home = "/home/dev";

  test("a clean persona: every check passes", () => {
    const raw = personaScan("expert");
    const a = analyze(raw, { timeZone: "UTC" });
    const { lines, failures } = analysisLines(raw, a, exportOf(a), home);
    expect(failures).toEqual([]);
    const v = valuesOf(lines);
    expect(ANALYSIS_CHECKS.map((k) => v[k])).toEqual(ANALYSIS_CHECKS.map(() => "PASS"));
    expect(lines.flatMap(offGrammar)).toEqual([]);
  });

  test("a displayed 99 without openTail fails not-saturated; a metric without n fails metrics-have-window-and-n", () => {
    const raw = personaScan("expert");
    const a = analyze(raw, { timeZone: "UTC" });
    const d = a.dimensions.find((x) => x.status === "scored")!;
    d.score = 99;
    d.openTail = false;
    (a.signals as unknown as Record<string, { n: unknown }>)[Object.keys(a.signals).find((k) => k !== "evidence" && k !== "repoSignals")!]!.n = undefined;
    const { lines, failures } = analysisLines(raw, a, exportOf(a), home);
    const v = valuesOf(lines);
    expect([v["not-saturated"], v["metrics-have-window-and-n"]]).toEqual(["FAIL", "FAIL"]);
    expect(failures.length).toBeGreaterThanOrEqual(2);
  });

  test("an export the schema refuses: a count of the violating paths, never a path, and both export checks fail", () => {
    const raw = personaScan("expert");
    const a = analyze(raw, { timeZone: "UTC" });
    a.dimensions[0]!.score = 1.5; // no integer: the schema would change it
    const exported = exportOf(a);
    const { lines, failures } = analysisLines(raw, a, exported, home);
    const v = valuesOf(lines);
    expect(v["export-violations"]).toMatch(/^[1-9]\d*$/);
    expect([v["export-no-raw-paths"], v["export-under-300kb"]]).toEqual(["FAIL", "FAIL"]);
    expect(lines.filter((l) => l.includes("$."))).toEqual([]);
    expect(failures.length).toBeGreaterThan(0);
  });

  test("a home path, a session cwd or a repo root in the export fails export-no-raw-paths; a bare root path never counts", () => {
    const raw = personaScan("expert");
    const a = analyze(raw, { timeZone: "UTC" });
    const exported = exportOf(a);
    if (!exported.ok) throw new Error("the persona's export must fit the schema");
    const leak = (json: string) => ({ ...exported, json });
    const at = (json: string, r = raw) => valuesOf(analysisLines(r, a, leak(json), home).lines)["export-no-raw-paths"];
    expect(at(`${exported.json}"${home}/x"`)).toBe("FAIL");
    expect(at(exported.json, { ...raw, cwds: new Map([["k", "/"]]) })).toBe("PASS");
    expect(at(`${exported.json}"C:\\\\work\\\\proj"`, { ...raw, cwds: new Map([["k", "C:\\work\\proj"]]) })).toBe("FAIL");
    const roots = new Map([["r", "/srv/repo-a"]]);
    expect(at(`${exported.json}/srv/repo-a`, { ...raw, repos: { ...raw.repos, roots } })).toBe("FAIL");
  });
});

describe("the smoke test's own grammar checks", () => {
  test("a token made only of = is a heading rule; any other token holding = must be key=value in the grammar", () => {
    expect(offGrammar("== coverage ===== a=1 b=PASS")).toEqual([]);
    expect(offGrammar("=leak x==y z=/Users/jo")).toEqual(["=leak", "x==y", "z=/Users/jo"]);
  });

  test("an epoch-millisecond integer is caught, a smaller or larger one is not", () => {
    expect(epochMs("files=12 at=1763337600000 big=10000000000000 ratio=0.999999999999 t=1763337600000.5")).toEqual(["1763337600000", "1763337600000.5"]);
  });
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
