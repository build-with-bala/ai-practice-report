import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, readdirSync } from "node:fs";
import path from "node:path";
import { analyze, type Analysis } from "../../core/analyze";
import type { ScanResult } from "../../core/scan";
import type { CoverageEv, Ev } from "../../core/model/events";
import { PAYLOAD_WORDS } from "../../core/privacy/schema";
import { analysisLines, coverageLine, exportOf, metricMetaProblems, warningsLine } from "../../scripts/smoke-local";
import { C as AG_C, I1, I2, K, P } from "../fixtures/antigravity";
import { CC_H1, CC_H2, CC_S1, CC_S2, CcTranscript, ccSid, fixtureStart, slug } from "../fixtures/claude-code";
import { S_J, S_L } from "../fixtures/copilot";
import { A, B } from "../fixtures/cursor";
import { personaScan } from "../fixtures/personas";
import { isolateGitHome, makeRepo } from "../fixtures/repos";
import { buildAll } from "../kit/allsources";
import { CANARY, expectNoCanaries } from "../kit/canary";
import { scanResultOf } from "../kit/scanresult";
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
const ANALYSIS_CHECKS = ["dimensions-scored", "not-saturated", "metrics-have-window-and-n", "export-no-raw-paths", "export-under-300kb", "forensics-ran"];
const skipChmod = process.platform === "win32" || process.getuid?.() === 0;

interface Run { code: number | null; out: string; err: string }

let h: FakeHome;
/** The fixtures' session ids, working directories and repo root: the smoke prints none of them. */
let secrets: string[];

/** A UUID, as Codex names its threads and rollout files. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * Every P0 source's fixtures (the shared kit's builder) and a git repo with a Claude Code session inside it; returns
 * the session ids, working directories and repo root they hold. The Codex thread ids are read back from the fake home
 * (rollout file names and the state index), since the kit's builder does not return them.
 */
function buildHome(): string[] {
  const planted = buildAll(h);
  // a real git repo with a Claude Code session working inside it, so repo signals find one repo
  const root = makeRepo(path.join(h.env.home, "code", "smoke-repo"), [
    { files: { "CLAUDE.md": "Run `npm test`.\n", "src/a.ts": "export const a = 1;\n" }, message: "init", at: Date.now() - 3 * 86_400_000 },
  ]);
  const sid = ccSid("SMOKE");
  h.writeJsonl(`.claude/projects/${slug(root)}/${sid}.jsonl`,
    new CcTranscript(sid, { cwd: root, start: fixtureStart(2) }).prompt("Fix the importer").tool("toolu_smoke", "Bash", { command: "npm test" }, { content: "ok" }).records);
  const codex: string[] = [];
  for (const f of readdirSync(path.join(h.env.home, ".codex", "sessions"), { recursive: true }) as string[]) codex.push(...(f.match(UUID) ?? []));
  const db = new Database(path.join(h.env.home, ".codex", "state_5.sqlite"), { readonly: true });
  try {
    codex.push(...(db.query("SELECT id FROM threads").all() as Array<{ id: string }>).map((r) => r.id));
  } finally {
    db.close();
  }
  expect(codex.length).toBeGreaterThanOrEqual(8);
  return [
    CC_S1, CC_S2, CC_H1, CC_H2, ...codex, planted.rollout, planted.thread, S_J, S_L, A, B, P, AG_C, K, I1, I2, CANARY.path, "/work/projB", "/work/projC", sid, root,
  ];
}

let restoreHome: () => void = () => {};
// the child gets the fake home's HOME below; this process's own git (and any engine call in it) gets one too
beforeEach(() => {
  h = fakeHome();
  restoreHome = isolateGitHome(path.join(h.root, "git-home"));
  secrets = buildHome();
});
afterEach(() => { restoreHome(); h.cleanup(); });

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

  /** The expert persona's scan and a fresh analysis of it, which a test may break. */
  const fresh = () => {
    const raw = personaScan("expert");
    return { raw, a: analyze(raw, { timeZone: "UTC" }) };
  };
  const checkOf = (key: string, raw: ScanResult, a: Analysis) => valuesOf(analysisLines(raw, a, exportOf(a), home).lines)[key];
  /** A signal metric of the analysis, as mutable data. */
  const signal = (a: Analysis) => a.signals.guardrails as unknown as Record<string, unknown>;

  for (const kind of ["novice", "intermediate", "expert"] as const) {
    test(`the ${kind} persona: every check passes, every metric's metadata is whole`, () => {
      const raw = personaScan(kind);
      const a = analyze(raw, { timeZone: "UTC" });
      expect(metricMetaProblems(a)).toMatchObject({ bad: [] });
      expect(metricMetaProblems(a).metrics).toBeGreaterThan(30);
      const { lines, failures } = analysisLines(raw, a, exportOf(a), home);
      expect(failures).toEqual([]);
      const v = valuesOf(lines);
      expect(ANALYSIS_CHECKS.map((k) => v[k])).toEqual(ANALYSIS_CHECKS.map(() => "PASS"));
      expect(lines).toContain("dimensions scored=" + a.dimensions.filter((d) => d.status === "scored").length + "/7");
      expect(lines.flatMap(offGrammar)).toEqual([]);
    });
  }

  const breaks: Array<[string, (a: Analysis) => void]> = [
    ["a dimension's meta deleted", (a) => { delete (a.dimensions[0] as Partial<typeof a.dimensions[0]>).meta; }],
    ["the overall's meta window deleted", (a) => { delete (a.overall.meta as Partial<typeof a.overall.meta>).window; }],
    ["a component's meta deleted", (a) => { delete (a.dimensions[0]!.components[0] as Partial<typeof a.dimensions[0]["components"][0]>).meta; }],
    ["a signal metric's sources deleted", (a) => { delete signal(a).sources; }],
    ["a signal metric's value and window set to undefined", (a) => { signal(a).value = undefined; signal(a).window = undefined; }],
    ["a signal metric's n set to undefined", (a) => { signal(a).n = undefined; }],
    ["the stack's meta deleted", (a) => { delete (a.stack as Partial<typeof a.stack>).meta; }],
    ["the risk posture's meta n made NaN", (a) => { a.risk.meta.n = Number.NaN; }],
  ];
  for (const [what, harm] of breaks) {
    test(`metrics-have-window-and-n fails on ${what}`, () => {
      const { raw, a } = fresh();
      const exported = exportOf(a); // before the harm: the exporter reads the metadata too, and may throw on it
      harm(a);
      expect(metricMetaProblems(a).bad.length).toBeGreaterThan(0);
      expect(valuesOf(analysisLines(raw, a, exported, home).lines)["metrics-have-window-and-n"]).toBe("FAIL");
    });
  }

  test("not-saturated: a 99 with the open-tail mark passes; a 99 without it, or any score above 99, fails", () => {
    const at = (score: number, openTail: boolean) => {
      const { raw, a } = fresh();
      const d = a.dimensions.find((x) => x.status === "scored")!;
      d.score = score;
      d.openTail = openTail;
      return checkOf("not-saturated", raw, a);
    };
    expect([at(99, true), at(99, false), at(100, true), at(100, false), at(98, false)]).toEqual(["PASS", "FAIL", "FAIL", "FAIL", "PASS"]);
  });

  /** Detail-window sessions of a scan with at least one typed (human) prompt. */
  const typedSessions = (raw: ScanResult): number => new Set(raw.store.all("prompt").filter((p) => p.window === "detail" && p.origin === "human" && p.sessionId !== undefined)
    .map((p) => p.sessionId)).size;

  /** A thin home: `n` detail sessions of one typed prompt each, too little for any dimension to score. */
  const thin = (n: number): ScanResult => {
    const t0 = Date.UTC(2026, 9, 1);
    const evs: Ev[] = [];
    for (let i = 0; i < n; i++) {
      const at = t0 + i * 3_600_000;
      evs.push({ k: "session", tool: "codex", source: "codex.rollouts", id: `codex:t${i}`, window: "detail", origin: "human", start: at, end: at + 60_000, models: [] });
      evs.push({ k: "prompt", tool: "codex", source: "codex.rollouts", ts: at + 1_000, sessionId: `codex:t${i}`, window: "detail", origin: "human", intent: "spec",
        textHash: `h${i}`, features: { words: 8, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: true, techCats: {} } });
    }
    return scanResultOf(evs, { finishedAt: t0 + n * 3_600_000 });
  };

  test("dimensions-scored: none scored fails from 100 typed detail sessions, and passes on a thinner home", () => {
    const { raw, a } = fresh();
    expect(checkOf("dimensions-scored", raw, a)).toBe("PASS");
    for (const [n, want] of [[0, "PASS"], [99, "PASS"], [100, "FAIL"]] as const) {
      const r = thin(n);
      const b = analyze(r, { timeZone: "UTC" });
      expect(typedSessions(r)).toBe(n);
      for (const d of b.dimensions) Object.assign(d, { status: "insufficient", score: null, interval: null }); // nothing scored, whatever the data
      expect(`${n} ${checkOf("dimensions-scored", r, b)}`).toBe(`${n} ${want}`);
    }
  });

  test("not-saturated: a scored dimension outside 1 to 99 fails; so does every scored one at an edge, once 3 or more are scored", () => {
    /** The expert's analysis with only the first `scored` dimensions scored, at the scores given. */
    const set = (scores: (i: number) => number, scored = 7) => {
      const { raw, a } = fresh();
      a.dimensions.forEach((d, i) => {
        if (i < scored) Object.assign(d, { status: "scored", score: scores(i), openTail: scores(i) === 99 });
        else Object.assign(d, { status: "insufficient", score: null, interval: null, openTail: false });
      });
      return checkOf("not-saturated", raw, a);
    };
    expect([set(() => 99), set(() => 1), set((i) => (i % 2 === 0 ? 1 : 99)), set(() => 0), set(() => -3), set((i) => (i === 0 ? 50 : 99))])
      .toEqual(["FAIL", "FAIL", "FAIL", "FAIL", "FAIL", "PASS"]);
    // one or two dimensions at an edge can be an honest thin home; three cannot
    expect([set(() => 99, 1), set(() => 1, 2), set(() => 99, 3), set(() => 0, 1)]).toEqual(["PASS", "PASS", "FAIL", "FAIL"]);
    const { raw, a } = fresh();
    a.dimensions.find((d) => d.status === "scored")!.score = null;
    expect(checkOf("not-saturated", raw, a)).toBe("FAIL");
  });

  test("forensics-ran: missing soft flags fail; so does every check n/a while Claude Code or Codex data is in scope", () => {
    const { raw, a } = fresh();
    expect(a.coverage.rows.some((r) => (r.tool === "claude-code" || r.tool === "codex") && r.sessions + r.prompts > 0)).toBe(true);
    expect(checkOf("forensics-ran", raw, a)).toBe("PASS");
    const noSoft = structuredClone(a);
    noSoft.forensics.checks = noSoft.forensics.checks.filter((c) => !c.id.startsWith("soft:"));
    expect(checkOf("forensics-ran", raw, noSoft)).toBe("FAIL");
    const allNa = structuredClone(a);
    for (const c of allNa.forensics.checks) c.status = "n/a";
    expect(checkOf("forensics-ran", raw, allNa)).toBe("FAIL");
    // with no Claude Code or Codex data, every check n/a is what an honest run gives
    const other = structuredClone(allNa);
    other.coverage.rows = other.coverage.rows.filter((r) => r.tool !== "claude-code" && r.tool !== "codex");
    expect(checkOf("forensics-ran", raw, other)).toBe("PASS");
  });

  test("export-no-raw-paths: a session folder's or repo root's name in the export fails; a short name or a payload word does not; only counts print", () => {
    const raw = personaScan("expert");
    const a = analyze(raw, { timeZone: "UTC" });
    const exported = exportOf(a);
    if (!exported.ok) throw new Error("the persona's export must fit the schema");
    const run = (json: string, r: ScanResult) => analysisLines(r, a, { ...exported, json }, home).lines;
    const cwds = new Map([["k", "/home/dev/clients/AcmePayroll"], ["j", "C:\\work\\prompts"], ["s", "/srv/abcd"]]);
    const roots = new Map([["r", "/srv/code/ledger-svc"]]);
    const withPaths = { ...raw, cwds, repos: { ...raw.repos, roots } };
    expect(valuesOf(run(exported.json, withPaths))["export-no-raw-paths"]).toBe("PASS");
    const leaked = run(`${exported.json}"acmepayroll"`, withPaths);
    expect(valuesOf(leaked)["export-no-raw-paths"]).toBe("FAIL");
    expect(valuesOf(leaked)["export-folder-names"]).toBe("1");
    expect(valuesOf(run(`${exported.json}"x/LEDGER-SVC"`, withPaths))["export-no-raw-paths"]).toBe("FAIL");
    // "prompts" is a word of the payload itself, and "abcd" is under 5 characters: neither counts
    expect(valuesOf(run(`${exported.json}abcd`, withPaths))).toMatchObject({ "export-no-raw-paths": "PASS", "export-folder-names": "0" });
    for (const l of [...leaked, ...run(exported.json, withPaths)]) expect(l.toLowerCase()).not.toMatch(/acme|ledger|abcd/);
    expect(leaked.flatMap(offGrammar)).toEqual([]);
  });

  test("export-no-raw-paths: a folder named like a public tool, name or payload word never counts, nor one inside a payload word", () => {
    const raw = personaScan("expert");
    const a = analyze(raw, { timeZone: "UTC" });
    const exported = exportOf(a);
    if (!exported.ok) throw new Error("the persona's export must fit the schema");
    expect(PAYLOAD_WORDS.has("prompt")).toBe(false); // a part of the payload word "prompts", but no word of its own
    const cwds = new Map(["github", "claude-code", "playwright", "sonnet", "fine-tuned", "subagents", "prompt", "techCategories"]
      .map((n, i) => [`k${i}`, `/home/dev/${n}`]));
    const r = { ...raw, cwds };
    const json = `${exported.json}"github""claude-code""playwright""claude-sonnet-4-5""fine-tuned"`;
    expect(json).toContain('"prompts"');
    const v = valuesOf(analysisLines(r, a, { ...exported, json }, home).lines);
    expect([v["export-no-raw-paths"], v["export-folder-names"]]).toEqual(["PASS", "0"]);
  });

  test("a missing dimension: the line still reads /7, and the analysis checks fail", () => {
    const { raw, a } = fresh();
    a.dimensions.pop();
    const { lines, failures } = analysisLines(raw, a, exportOf(a), home);
    expect(lines.filter((l) => l.startsWith("dimensions scored="))).toEqual([expect.stringMatching(/^dimensions scored=\d\/7$/)]);
    expect(failures).toContain("dimension count");
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
    // case and separators do not hide a path
    expect(at(`${exported.json}"${home.toUpperCase()}/x"`)).toBe("FAIL");
    expect(at(`${exported.json}c:/work/proj`, { ...raw, cwds: new Map([["k", "C:\\work\\proj"]]) })).toBe("FAIL");
    expect(at(`${exported.json}/SRV/Repo-A`, { ...raw, repos: { ...raw.repos, roots } })).toBe("FAIL");
    expect(at(exported.json, { ...raw, cwds: new Map([["k", "C:\\"], ["j", "C:/"]]) })).toBe("PASS");
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

describe("the smoke's warnings line", () => {
  test("a warning's code and source print only as codes: anything else is other", () => {
    const line = warningsLine([
      { tool: "codex", source: "codex.rollouts", code: "parse-error" }, { tool: "codex", source: CANARY.path, code: CANARY.prompt },
      { tool: "codex", source: "codex.rollouts", code: `${CANARY.slug} /x` },
    ] as unknown as ScanResult["warnings"]);
    expect(line).toBe("warnings: other:codex.rollouts=1 other:other=1 parse-error:codex.rollouts=1");
    expectNoCanaries(line);
    expect(offGrammar(line)).toEqual([]);
  });
});
