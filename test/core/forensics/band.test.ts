import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildSessionTable } from "../../../core/analysis/sessions";
import { buildSessionStats, type SessionStats } from "../../../core/analysis/walk";
import { bandOf, runForensics, type Forensics } from "../../../core/forensics";
import type { ReleaseTable } from "../../../core/forensics/releases";
import type { CheckResult } from "../../../core/forensics/types";
import type { AnchorEv, ConfigEv, CoverageEv, DailyEv, Ev, FileFactEv, IdentityEv, PromptEv, SessionEv, ToolEv } from "../../../core/model/events";
import type { ToolId, Window } from "../../../core/model/ids";
import { scanResultOf } from "../../kit/scanresult";
import { asks } from "./table";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 1, 8, 0);
const NOW = T0 + 40 * DAY;
const CC = "claude-code.transcripts";
const TABLE: ReleaseTable = { version: 1, models: [], tools: {} };

/** A seeded generator (mulberry32): the fixtures are the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function enc(v: bigint, width: number): string {
  let s = "";
  for (let x = v; x > 0n; x /= 58n) s = B58[Number(x % 58n)]! + s;
  return s.padStart(width, "1");
}
const randomB58 = (r: () => number, len: number): string => Array.from({ length: len }, () => B58[Math.floor(r() * 58)]!).join("");
/** 2,000 anchors over 20 days whose ids grow linearly with time, as the service mints them. */
function anchors(kind: AnchorEv["kind"] = "cc-msg", seed = 1): AnchorEv[] {
  const r = rng(seed);
  return Array.from({ length: 2_000 }, (_, i) => {
    const ts = T0 + i * 14 * MIN + Math.floor(r() * MIN);
    const tail = `01${enc(3n * 58n ** 11n + BigInt(ts - T0) * 1_000n, 12)}${randomB58(r, 10)}`;
    return { k: "anchor", tool: "claude-code", source: CC, kind, ts, idTail: tail };
  });
}
const edited = (as: AnchorEv[]): AnchorEv[] => as.map((e, i) => (i % 33 === 5 ? { ...e, ts: e.ts + 2 * HOUR } : e));
const reversed = (as: AnchorEv[]): AnchorEv[] => {
  const times = as.map((e) => e.ts).reverse();
  return as.map((e, i) => ({ ...e, ts: times[i]! }));
};
const scrambled = (as: AnchorEv[], seed: number): AnchorEv[] => {
  const r = rng(seed);
  return as.map((e) => ({ ...e, idTail: `01${randomB58(r, 22)}` }));
};
const malformed = (as: AnchorEv[]): AnchorEv[] => [...as, ...as.slice(0, 200).map((e) => ({ ...e, idTail: `01${"0".repeat(22)}` }))];

const cov = (tool: ToolId, source: string, window: Window, over: Partial<CoverageEv> = {}): CoverageEv => ({
  k: "coverage", tool, source, window, status: "ok", beta: false, files: 1, bytes: 1, records: 1, skipped: {}, unknownTypes: {}, versions: [], ...over,
});
const sess = (id: string, tool: ToolId = "claude-code", start = T0, over: Partial<SessionEv> = {}): SessionEv => ({
  k: "session", tool, source: tool === "claude-code" ? CC : `${tool}.x`, id, window: "detail", origin: "human", start, end: start + HOUR, models: [], ...over,
});
const features = { words: 5, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: false, techCats: {} } as const;
let hashes = 0;
const prompt = (sessionId: string, ts: number, tool: ToolId = "claude-code", over: Partial<PromptEv> = {}): PromptEv => ({
  k: "prompt", tool, source: tool === "claude-code" ? CC : `${tool}.x`, ts, sessionId, window: "detail", origin: "human", intent: "spec",
  textHash: `h${++hashes}`, features, ...over,
});
const history = (ts: number, textHash: string): PromptEv =>
  ({ k: "prompt", tool: "claude-code", source: "claude-code.history", ts, window: "lifetime", origin: "human", intent: "spec", textHash, features });
const statsDay = (day: string): DailyEv => ({ k: "daily", tool: "claude-code", source: "claude-code.stats", day, zone: "utc", unit: "messages", count: 10 });
const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const identity = (scope: IdentityEv["scope"], hash: string): IdentityEv => ({ k: "identity", tool: "claude-code", source: CC, scope, hash });
const file = (i: number, over: Partial<FileFactEv> = {}): FileFactEv => {
  const firstTs = T0 + i * DAY;
  return { k: "file", tool: "claude-code", source: CC, pathHash: `f${i}`, bytes: 1, birth: firstTs, firstTs, lastTs: firstTs + HOUR,
    mtime: firstTs + HOUR + SEC, ctime: firstTs + HOUR + SEC, ...over };
};
const files = (n: number, f: (i: number) => FileFactEv = (i) => file(i)): FileFactEv[] => Array.from({ length: n }, (_, i) => f(i));

/**
 * Ten days of typed transcript prompts in one session, three a day (a C3 pass needs 20 compared), with those of the first
 * `inHistory` days echoed in the prompt history.
 */
function claudeDays(inHistory: number, statsDays: (day: string, i: number) => boolean = () => false): Ev[] {
  const out: Ev[] = [sess("s", "claude-code", T0, { end: T0 + 10 * DAY })];
  for (let i = 0; i < 10; i++) {
    for (let k = 0; k < 3; k++) {
      const ts = T0 + i * DAY + k * HOUR;
      out.push(prompt("s", ts, "claude-code", { textHash: `p${i}-${k}` }));
      if (i < inHistory) out.push(history(ts + 5 * SEC, `p${i}-${k}`));
    }
    const ts = T0 + i * DAY;
    if (statsDays(ymd(ts), i)) out.push(statsDay(ymd(ts)));
  }
  out.push(history(T0 - DAY, "early"), history(T0 + 12 * DAY, "late"));
  return out;
}

const run = (events: Ev[], stats: readonly SessionStats[] = [], releases: ReleaseTable = TABLE): Forensics => {
  const raw = scanResultOf(events, { finishedAt: NOW });
  const t = buildSessionTable(raw, { now: NOW, timeZone: "UTC" });
  const f = runForensics(raw, t, stats, { now: NOW, timeZone: "UTC", releases });
  asks(f.checks);
  return f;
};
const byId = (f: Forensics, id: CheckResult["id"]): CheckResult => f.checks.find((c) => c.id === id)!;
const ORDER: CheckResult["id"][] = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10",
  "soft:rhythm", "soft:repeated-long", "soft:recent-burst", "soft:unclosed-tools", "soft:new-config", "soft:no-server-pass", "soft:missing-ids"];
const statsOf = (rows: [ToolId, number][]): SessionStats[] => rows.map(([tool, turns]) => ({ tool, turns }) as SessionStats);

describe("runForensics: the band", () => {
  test("only Cursor and Copilot data is unverifiable, and both are not anchorable", () => {
    const f = run([sess("c", "cursor"), prompt("c", T0 + MIN, "cursor"), sess("p", "copilot"), prompt("p", T0 + MIN, "copilot")]);
    expect(f.band).toBe("unverifiable");
    expect(f.anchorable).toEqual([]);
    expect(f.notAnchorable).toEqual(["copilot", "cursor"]);
    expect(f.serverBacked).toBeNull();
  });

  test("genuine server ids alone are consistent; Claude Code and Codex are anchorable", () => {
    const f = run([...anchors("cc-msg", 1), ...anchors("cc-req", 2), sess("s"), sess("x", "codex")]);
    expect(byId(f, "C1").status).toBe("pass");
    expect(f.band).toBe("consistent");
    expect(f.anchorable).toEqual(["claude-code", "codex"]);
    expect(f.notAnchorable).toEqual([]);
  });

  test("a C3 warn and nothing failing is consistent with notes", () => {
    const f = run(claudeDays(6));
    expect(byId(f, "C3").status).toBe("warn");
    expect(f.checks.some((c) => c.status === "fail")).toBe(false);
    expect(f.band).toBe("consistent-with-notes");
  });

  test("a C1 fail is inconsistent", () => {
    const f = run([...edited(anchors()), ...claudeDays(10)]);
    expect(byId(f, "C1").status).toBe("fail");
    expect(f.band).toBe("inconsistent");
  });

  test("unverifiable ids with nothing else passing are unverifiable", () => {
    const f = run(scrambled(anchors("cc-msg", 1), 5));
    expect([byId(f, "C1").status, byId(f, "C1").reason]).toEqual(["n/a", "scheme-changed"]);
    expect(f.checks.some((c) => c.status === "pass" && /^C\d$/.test(c.id))).toBe(false);
    expect(f.band).toBe("unverifiable");
  });

  test("ids that exist but cannot be verified downgrade a passing band to notes, never plain consistent", () => {
    // cc-msg passes, cc-req no longer tracks time: C1 and C2 are n/a (scheme-changed), with one unverified kind
    const f = run([...anchors("cc-msg", 1), ...scrambled(anchors("cc-req", 2), 5), ...claudeDays(10)]);
    expect(byId(f, "C1").status).toBe("n/a");
    expect(byId(f, "C1").values.unverifiedKinds).toBe(1);
    expect(byId(f, "C3").status).toBe("pass");
    expect(f.band).toBe("consistent-with-notes");
  });

  test("unverifiable ids with every other anchorable check n/a are unverifiable, whatever C5 and C9 say", () => {
    const f = run([...scrambled(anchors("cc-msg", 1), 5), ...files(20)]);
    expect(byId(f, "C1").reason).toBe("scheme-changed");
    expect(byId(f, "C5").status).toBe("pass");
    expect(f.band).toBe("unverifiable");
  });

  test("unverifiable ids with C4 passing are consistent with notes", () => {
    const f = run([...scrambled(anchors("cc-msg", 1), 5), sess("a"), ...Array.from({ length: 5 }, () => identity("session", "a")), identity("config", "a")]);
    expect(byId(f, "C4").status).toBe("pass");
    expect(f.band).toBe("consistent-with-notes");
  });

  test("Cursor-only data is unverifiable, with a C9 pass and a C5 pass, or with a C5 note", () => {
    const releases: ReleaseTable = { version: 1, models: [{ match: "^model-x$", released: "2020-01-01", source: "https://example.com/x" }], tools: {} };
    const cursorFile = (f: FileFactEv): FileFactEv => ({ ...f, tool: "cursor", source: "cursor.x" });
    const base: Ev[] = [sess("c", "cursor", T0, { models: ["model-x"] }), prompt("c", T0 + MIN, "cursor")];
    const passing = run([...base, ...files(20).map(cursorFile)], [], releases);
    expect([byId(passing, "C9").status, byId(passing, "C5").status]).toEqual(["pass", "pass"]);
    expect(passing.band).toBe("unverifiable");
    const restored = files(20, (i) => file(i * 1.5, { birth: T0 + 50 * DAY + i * 10 * SEC, ctime: T0 + 50 * DAY + i * 10 * SEC })).map(cursorFile);
    const noted = run([...base, ...restored], [], releases);
    expect(byId(noted, "C5").status).toBe("note");
    expect(noted.band).toBe("unverifiable");
  });

  test("a C3 warn with every other check n/a is consistent with notes", () => {
    const f = run(claudeDays(6));
    expect(f.checks.filter((c) => c.id !== "C3" && /^C\d$/.test(c.id)).every((c) => c.status === "n/a")).toBe(true);
    expect(f.band).toBe("consistent-with-notes");
  });

  test("too few ids stay neutral, but C3 passing alone is no server-backed pass: consistent with notes", () => {
    const f = run([...anchors().slice(0, 30), ...claudeDays(10)]);
    expect(byId(f, "C1").reason).toBe("too-few");
    expect(byId(f, "C3").status).toBe("pass");
    expect([byId(f, "soft:no-server-pass").status, byId(f, "soft:no-server-pass").reason]).toEqual(["note", "no-server-pass"]);
    expect(f.band).toBe("consistent-with-notes");
    const g = run([...anchors(), ...claudeDays(10)]);
    expect([byId(g, "soft:no-server-pass").status, g.band]).toEqual(["pass", "consistent"]);
  });

  test("a raised soft flag alone makes notes", () => {
    const cfg = (name: string): ConfigEv =>
      ({ k: "config", tool: "claude-code", source: "claude-code.config", kind: "skill", name, provenance: "authored", uses: 2, firstSeen: NOW - DAY });
    const f = run([...anchors("cc-msg", 1), cfg("a"), cfg("b"), cfg("c")]);
    expect(byId(f, "soft:new-config").status).toBe("note");
    expect(f.band).toBe("consistent-with-notes");
  });

  test("checks list C1 to C10, then the soft flags, every time", () => {
    for (const evs of [[], claudeDays(6), [...edited(anchors()), sess("c", "cursor")]]) {
      expect(run(evs).checks.map((c) => c.id)).toEqual(ORDER);
    }
    expect(byId(run(claudeDays(6)), "C10").status).toBe("info");
  });
});

describe("runForensics: consistent needs evidence", () => {
  const cursor = (): Ev[] => [sess("c", "cursor", T0, { end: T0 + 40 * DAY }), ...Array.from({ length: 1_200 }, (_, i) => prompt("c", T0 + i * 20 * MIN, "cursor"))];
  const threads = cov("codex", "codex.threads", "lifetime");

  test("1,200 Cursor prompts plus one matching item are never consistent", () => {
    const account = run([...cursor(), sess("a"), identity("session", "a"), identity("config", "a")]);
    const inHistory = run([...cursor(), sess("s"), prompt("s", T0, "claude-code", { textHash: "x" }), history(T0 + SEC, "x"),
      history(T0 - DAY, "e"), history(T0 + DAY, "l")]);
    const rollout = run([...cursor(), threads, { k: "codex-rollout", tool: "codex", source: "codex.rollouts", threadId: "codex:r", fileTs: T0, uuidTs: T0 + 400 },
      { k: "codex-thread-row", tool: "codex", source: "codex.threads", threadId: "codex:r", createdAt: T0 + 300 }]);
    for (const f of [account, inHistory, rollout]) {
      expect(f.band).not.toBe("consistent");
      expect(f.band).toBe("unverifiable");
    }
  });

  test("a history written from nothing, with the account id copied in, is at best consistent with notes, and asks about the missing ids", () => {
    const evs: Ev[] = [identity("config", "acct")];
    for (let k = 0; k < 30; k++) {
      const id = `f${k}`;
      evs.push(sess(id, "claude-code", T0 + k * DAY), { ...identity("session", "acct"), sessionId: id });
      for (let i = 0; i < 60; i++) evs.push(prompt(id, T0 + k * DAY + i * MIN));
    }
    const f = run(evs, statsOf(Array.from({ length: 30 }, () => ["claude-code", 60] as [ToolId, number])));
    expect(byId(f, "C4").status).toBe("pass");
    expect([byId(f, "soft:no-server-pass").status, byId(f, "soft:missing-ids").status, byId(f, "soft:missing-ids").values.turns]).toEqual(["note", "note", 1_800]);
    expect(byId(f, "soft:missing-ids").askAbout).toBe("1800 typed turns come from a tool that records server-issued ids, but none of them carries one. Were these sessions run through another provider or a gateway?");
    expect(f.band).toBe("consistent-with-notes");
  });

  test("missing ids: n/a under 50 typed turns, a pass when the tool has ids", () => {
    expect(byId(run([sess("s")], statsOf([["claude-code", 49]])), "soft:missing-ids").status).toBe("n/a");
    expect(byId(run([sess("s"), ...anchors()], statsOf([["claude-code", 50]])), "soft:missing-ids").status).toBe("pass");
    expect(byId(run([sess("c", "codex")], statsOf([["codex", 500]])), "soft:missing-ids").status).toBe("n/a"); // Codex records no server ids
  });

  test("the band truth table", () => {
    const r = (id: CheckResult["id"], status: CheckResult["status"], reason: CheckResult["reason"] = "ok", values: CheckResult["values"] = {}): CheckResult =>
      ({ id, status, n: 1, reason, values, tools: [] });
    const na = (id: CheckResult["id"]) => r(id, "n/a", "too-few");
    const rows: [string, CheckResult[], Forensics["band"]][] = [
      ["a fail anywhere", [r("C1", "pass"), r("C5", "fail", "file-times")], "inconsistent"],
      ["a soft fail would be too", [r("C1", "pass"), r("soft:rhythm", "fail", "regular-rhythm")], "inconsistent"],
      ["every anchored check n/a, C5 and C9 passing", [na("C1"), na("C2"), na("C3"), na("C4"), r("C5", "pass"), na("C6"), na("C7"), na("C8"), r("C9", "pass")], "unverifiable"],
      ["every anchored check n/a, a note", [na("C1"), na("C3"), r("C5", "note", "restore-cluster")], "unverifiable"],
      ["C1 pass and a warn", [r("C1", "pass"), r("C3", "warn", "history-mismatch")], "consistent-with-notes"],
      ["C1 pass and a soft note", [r("C1", "pass"), r("soft:new-config", "note", "new-config")], "consistent-with-notes"],
      ["C1 pass and an unverified kind", [r("C1", "pass", "ok", { unverifiedKinds: 1 })], "consistent-with-notes"],
      ["C2 n/a scheme-changed, C3 pass", [r("C2", "n/a", "scheme-changed"), r("C3", "pass")], "consistent-with-notes"],
      ["own-record passes only (C3, C4, C6, C7)", [na("C1"), na("C2"), r("C3", "pass"), r("C4", "pass"), r("C6", "pass"), r("C7", "pass"), na("C8")], "consistent-with-notes"],
      ["C1 pass, nothing else", [r("C1", "pass"), na("C3")], "consistent"],
      ["C8 pass, nothing else", [na("C1"), r("C8", "pass")], "consistent"],
      ["C2 pass with C3 pass", [r("C2", "pass"), r("C3", "pass")], "consistent"],
    ];
    for (const [name, checks, band] of rows) expect([name, bandOf(checks)]).toEqual([name, band]);
  });
});

describe("provenance (C10)", () => {
  test("prompt counts by tool, origin and window, classified only", () => {
    const f = run([sess("s"), prompt("s", T0 + MIN), prompt("s", T0 + 2 * MIN), history(T0 + 3 * MIN, "a"),
      prompt("s", T0 + 4 * MIN, "claude-code", { origin: "scripted" }), sess("c", "cursor"), prompt("c", T0 + MIN, "cursor")]);
    const c = byId(f, "C10");
    // n: the prompts of each tool's one window (Claude Code's detail window here), never both windows summed
    expect([c.status, c.reason, c.n]).toEqual(["info", "classify-only", 4]);
    expect(c.values).toEqual({ "claude-code/human/detail": 2, "claude-code/human/lifetime": 1, "claude-code/scripted/detail": 1, "cursor/human/detail": 1 });
    expect(c.tools).toEqual(["claude-code", "cursor"]);
    expect(byId(run([]), "C10").status).toBe("n/a");
  });
});

describe("runForensics: the server-backed share", () => {
  test("typed turns of tools whose server checks pass, over all typed turns", () => {
    const f = run([...anchors("cc-msg", 1), ...anchors("cc-req", 2)], statsOf([["claude-code", 20], ["claude-code", 10], ["cursor", 10]]));
    expect(f.serverBacked).toBe(0.75);
  });

  test("a C1 fail backs nothing; Codex is backed by C8; no typed turns is null", () => {
    expect(run(edited(anchors()), statsOf([["claude-code", 30], ["cursor", 10]])).serverBacked).toBe(0);
    expect(run([], statsOf([["claude-code", 0]])).serverBacked).toBeNull();
    const ledger = Array.from({ length: 30 }, (_, i) => ({
      k: "ratelimit", tool: "codex", source: "codex.rollouts", ts: T0 + i * MIN, window: "primary", windowMinutes: 300,
      usedPercent: i, resetsAt: T0 + 5 * HOUR,
    }) as Ev);
    expect(run(ledger, statsOf([["codex", 3], ["copilot", 1]])).serverBacked).toBe(0.75);
  });

  test("a forensic fail never changes the session statistics that every dimension score is computed from", () => {
    const tools: ToolEv[] = Array.from({ length: 6 }, (_, i) => ({
      k: "tool", tool: "claude-code", source: CC, ts: T0 + i * DAY + MIN, sessionId: "s", name: "Edit", category: "edit", ok: true,
    }));
    const events: Ev[] = [cov("claude-code", CC, "detail"), ...edited(anchors()), ...claudeDays(10), ...tools];
    const raw = scanResultOf(events, { finishedAt: NOW });
    const t = buildSessionTable(raw, { now: NOW, timeZone: "UTC" });
    const stats = buildSessionStats(t, raw.store, raw.repos, { timeZone: "UTC" });
    const before = JSON.stringify(stats);
    const f = runForensics(raw, t, stats, { now: NOW, timeZone: "UTC", releases: TABLE });
    asks(f.checks);
    expect(f.band).toBe("inconsistent");
    expect(JSON.stringify(stats)).toBe(before);
    expect(JSON.stringify(buildSessionStats(t, raw.store, raw.repos, { timeZone: "UTC" }))).toBe(before);
  });

  test("forensics imports nothing from scoring", () => {
    const dir = path.join(import.meta.dir, "../../../core/forensics");
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      expect(readFileSync(path.join(dir, name), "utf8")).not.toMatch(/from\s+"[^"]*scoring/);
    }
  });
});

describe("wording: every reason and question the forensic checks produce", () => {
  const moved = T0 + 50 * DAY;
  const scenarios: Ev[][] = [
    [],
    [...anchors("cc-msg", 1), ...anchors("cc-req", 2)],
    edited(anchors()),
    reversed(anchors()),
    malformed(anchors()),
    scrambled(anchors(), 3),
    claudeDays(6),
    claudeDays(10, (_, i) => i === 0 || i === 9),
    claudeDays(10, (_, i) => i < 3 || i > 5),
    [sess("a"), identity("session", "a"), identity("config", "b")],
    [sess("a"), identity("session", "a"), identity("session", "c"), identity("config", "a")],
    files(20, (i) => (i < 3 ? file(i, { mtime: T0 }) : file(i))),
    files(20, (i) => file(i * 1.5, { birth: moved + i * 10 * SEC, ctime: moved + i * 10 * SEC })),
    files(20, (i) => file(i * 1.5, { ctime: moved + i * 10 * SEC })),
    [cov("codex", "codex.threads", "lifetime", { records: 5 }),
      { k: "codex-rollout", tool: "codex", source: "codex.rollouts", threadId: "codex:a", fileTs: T0, uuidTs: T0 + 5 * SEC },
      { k: "codex-rollout", tool: "codex", source: "codex.rollouts", threadId: "codex:b", fileTs: T0, uuidTs: T0 + 3 * HOUR }],
    [{ k: "codex-rollout", tool: "codex", source: "codex.rollouts", threadId: "codex:b", fileTs: T0, uuidTs: T0 + 3 * HOUR }],
    Array.from({ length: 60 }, (_, i) => ({
      k: "ratelimit", tool: "codex", source: "codex.rollouts", ts: T0 + i * MIN, window: "primary", usedPercent: (i % 2) * 50 + i / 10, resetsAt: T0 + 5 * HOUR,
    }) as Ev),
    [sess("m", "claude-code", T0, { models: ["model-x"] })],
    [
      sess("s", "claude-code", NOW - 3 * DAY, { end: NOW }), cov("claude-code", CC, "detail"),
      ...Array.from({ length: 61 }, (_, i) => prompt("s", NOW - 3 * DAY + i * MIN, "claude-code",
        { textHash: i < 5 ? "x" : `u${i}`, features: { ...features, chars: 300 } })),
      ...["r2", "r3", "r4", "r5"].flatMap((id): Ev[] => [sess(id, "claude-code", NOW - 3 * DAY, { end: NOW }),
        ...Array.from({ length: 61 }, (_, i) => prompt(id, NOW - 3 * DAY + i * MIN))]),
      ...[80, 1, 2, 3].map((d) => history(NOW - d * DAY, `l${d}`)),
      ...Array.from({ length: 10 }, (_, i): ToolEv => ({ k: "tool", tool: "claude-code", source: CC, ts: NOW - DAY + i, sessionId: "s", name: "Read", category: "read" })),
      ...["a", "b", "c"].map((name): ConfigEv => ({ k: "config", tool: "claude-code", source: "claude-code.config", kind: "skill", name, provenance: "authored", uses: 1, firstSeen: NOW - DAY })),
    ],
  ];
  const releases: ReleaseTable = { version: 1, models: [{ match: "^model-x$", released: "2027-01-01", source: "https://example.com/x" }], tools: {} };
  const results = scenarios.flatMap((evs) => run(evs, [], releases).checks);

  test("every character is in U+0020-00FF or U+2000-206F, or is U+2212", () => {
    for (const c of results) expect(`${c.reason}${c.askAbout ?? ""}`).toMatch(/^[ -ÿ -⁯−]*$/);
  });

  test("the scenarios reach every question", () => {
    const asked = new Set(results.filter((c) => c.askAbout !== undefined).map((c) => `${c.id}:${c.reason}`));
    expect([...asked].sort()).toEqual([
      "C1:malformed-ids", "C1:off-time", "C1:scheme-changed", "C2:out-of-order", "C2:scheme-changed", "C3:history-mismatch", "C3:missing-stats-days", "C4:no-match",
      "C4:several-accounts", "C5:changed-after-write", "C5:file-times", "C5:restore-cluster", "C6:missing-thread-rows", "C7:time-zone-change",
      "C7:uuid-after-name", "C8:ledger-contradictions", "C9:before-release", "soft:new-config:new-config",
      "soft:recent-burst:recent-burst", "soft:repeated-long:repeated-long", "soft:rhythm:regular-rhythm", "soft:unclosed-tools:unclosed-tools",
      "soft:no-server-pass:no-server-pass",
    ].sort());
    const statuses = new Set(results.filter((c) => c.id === "C3").map((c) => c.status));
    expect(statuses.has("note") && statuses.has("fail") && statuses.has("warn")).toBe(true);
  });

  test("values hold numbers and dates only, and reasons are short codes", () => {
    for (const c of results) {
      expect(c.reason).toMatch(/^[a-z0-9-]+$/);
      for (const v of Object.values(c.values)) expect(typeof v === "number" ? Number.isFinite(v) : /^\d{4}-\d{2}-\d{2}$/.test(v)).toBe(true);
    }
  });
});

describe("runForensics: the closed vocabularies are guarded at run time", () => {
  test("a result with an unlisted reason or value key throws, naming only the check", async () => {
    const { guardVocabulary } = await import("../../../core/forensics");
    const ok: CheckResult = { id: "C6", status: "pass", n: 1, reason: "ok", values: { missing: 0 }, tools: [] };
    expect(() => guardVocabulary([ok])).not.toThrow();
    const values = Object.fromEntries([["cwd", 1]]) as CheckResult["values"];
    expect(() => guardVocabulary([{ ...ok, values }])).toThrow("forensics: C6 holds a value key outside the closed list");
    expect(() => guardVocabulary([{ ...ok, reason: "made-up" as CheckResult["reason"] }])).toThrow("forensics: C6 holds a reason outside the closed list");
  });

  test("C1 and C2 never share one tools array", () => {
    for (const evs of [anchors(), anchors().slice(0, 30), scrambled(anchors(), 3)]) {
      const f = run(evs);
      expect(byId(f, "C1").tools === byId(f, "C2").tools).toBe(false);
    }
  });
});
