import { describe, expect, test } from "bun:test";
import type { Exclusions } from "../../../core/analysis/types";
import { runForensics, type Forensics } from "../../../core/forensics";
import type { CheckId, CheckResult } from "../../../core/forensics/types";
import type { Ev } from "../../../core/model/events";
import type { ScanResult } from "../../../core/scan";
import { scanResultOf } from "../../kit/scanresult";
import { asks, tableOf } from "./table";
import { DAY, HOUR, MID, NOW, scanOf, T0, TABLE, world, type Tagged } from "./world";

/*
 * Every check and soft flag reads in-scope data only. Excluding a slice of the world must give, check by check, what
 * the same world without that slice gives: the excluded data reaches no check. Events that name a session (anchors,
 * file facts and usage-limit readings among them) follow that session; sessionless ones (and per-day totals) cannot
 * be tied to a project, so a project exclusion leaves them in.
 */

const run = (raw: ScanResult, exclude?: Exclusions): Forensics => {
  const f = runForensics(raw, tableOf(raw, exclude), [], { now: NOW, timeZone: "UTC", releases: TABLE });
  asks(f.checks);
  return f;
};
const byId = (f: Forensics, id: CheckId): CheckResult => f.checks.find((c) => c.id === id)!;
const ALL: CheckId[] = ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10",
  "soft:rhythm", "soft:repeated-long", "soft:recent-burst", "soft:unclosed-tools", "soft:new-config"];

interface Case { name: string; exclude: Exclusions; drop: (x: Tagged) => boolean; changes: CheckId[] }
const CASES: Case[] = [
  { name: "an excluded tool (Codex)", exclude: { tools: ["codex"] }, drop: (x) => x.tool === "codex",
    changes: ["C6", "C7", "C8", "C9", "C10", "soft:rhythm", "soft:new-config"] },
  { name: "an excluded tool (Claude Code)", exclude: { tools: ["claude-code"] }, drop: (x) => x.tool === "claude-code",
    changes: ["C1", "C2", "C3", "C4", "C5", "C9", "C10", "soft:rhythm", "soft:repeated-long", "soft:recent-burst", "soft:unclosed-tools", "soft:new-config"] },
  { name: "an excluded project", exclude: { projects: ["kB"] }, drop: (x) => x.project === "B",
    // the history keeps its sessionless echoes of project B's prompts, so B's days stay active: recent-burst stays; the
    // server ids, trace files and usage-limit readings that name B's sessions go with them
    changes: ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "soft:rhythm", "soft:repeated-long", "soft:unclosed-tools", "soft:new-config"] },
  { name: "a date range from the middle", exclude: { from: MID }, drop: (x) => x.period === 0,
    changes: ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "soft:rhythm", "soft:repeated-long", "soft:recent-burst", "soft:unclosed-tools"] },
  { name: "a date range up to the middle", exclude: { to: MID }, drop: (x) => x.period === 1,
    changes: ["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10", "soft:rhythm", "soft:repeated-long", "soft:recent-burst", "soft:unclosed-tools"] },
];

describe("forensics over in-scope data only", () => {
  const all = world();
  const full = run(scanOf(all));

  test("the world gives every check data to measure", () => {
    for (const id of ALL) expect([id, byId(full, id).status === "n/a"]).toEqual([id, false]);
  });

  for (const c of CASES) {
    test(`${c.name}: each check equals the world without it`, () => {
      const excluded = run(scanOf(all), c.exclude);
      const without = run(scanOf(all.filter((x) => !c.drop(x))));
      for (const id of ALL) expect([id, byId(excluded, id)]).toEqual([id, byId(without, id)]);
      expect([excluded.band, excluded.anchorable, excluded.notAnchorable]).toEqual([without.band, without.anchorable, without.notAnchorable]);
    });

    test(`${c.name}: the checks with data in the slice change, the others do not`, () => {
      const excluded = run(scanOf(all), c.exclude);
      const changed = ALL.filter((id) => !Bun.deepEquals(byId(excluded, id), byId(full, id)));
      expect(changed).toEqual(c.changes);
    });
  }

  test("an excluded tool leaves the anchorable lists", () => {
    const f = run(scanOf(all), { tools: ["codex"] });
    expect([full.anchorable, f.anchorable]).toEqual([["claude-code", "codex"], ["claude-code"]]);
  });

  test("an exclusion that matches nothing changes nothing", () => {
    const raw = scanOf(all);
    expect(run(raw, { tools: ["aider"] })).toEqual(run(raw));
  });

  test("an excluded project's prompts do not decide a tool's window", () => {
    // Cursor's window is detail only through project B's prompts: without B its lifetime prompts, one long one sent 6
    // times, are read; Claude Code's two kept sessions each hold one repeated long prompt
    expect(byId(full, "soft:repeated-long").values.repeated).toBe(4);
    expect(byId(run(scanOf(all), { projects: ["kB"] }), "soft:repeated-long").values.repeated).toBe(3);
  });

  test("a tool whose only session is a host copy is in no check and in neither list", () => {
    expect([full.anchorable, full.notAnchorable]).toEqual([["claude-code", "codex"], ["cursor"]]);
    for (const c of full.checks) expect([c.id, c.tools.includes("copilot")]).toEqual([c.id, false]);
    expect(Object.keys(byId(full, "C10").values).some((k) => k.startsWith("copilot/"))).toBe(false);
  });

  test("orphans: tool calls, detail prompts, session accounts, ids, file facts and limit readings are out; lifetime prompts, rollouts and thread rows stay", () => {
    const bare = run(scanOf(all.filter((x) => x.case !== "orphan")));
    for (const id of ["C1", "C2", "C4", "C5", "C8", "soft:unclosed-tools"] as const) expect([id, byId(full, id)]).toEqual([id, byId(bare, id)]);
    expect(byId(full, "C10").n - byId(bare, "C10").n).toBe(1);
    expect(byId(full, "C10").values["claude-code/human/lifetime"]! - byId(bare, "C10").values["claude-code/human/lifetime"]!).toBe(1);
    expect([byId(full, "C6").values.rollouts! - byId(bare, "C6").values.rollouts!, byId(full, "C6").values.missing]).toEqual([1, byId(bare, "C6").values.missing]);
    expect(byId(full, "C7").n - byId(bare, "C7").n).toBe(1);
  });
});

describe("C6 under a project exclusion", () => {
  test("an excluded project's thread rows do not set the index start", () => {
    const cov: Ev = { k: "coverage", tool: "codex", source: "codex.threads", window: "lifetime", status: "ok", beta: false, files: 1, bytes: 1,
      records: 2, skipped: {}, unknownTypes: {}, versions: [] };
    const session = (id: string, start: number, projectKey: string): Ev =>
      ({ k: "session", tool: "codex", source: "codex.rollouts", id, window: "detail", origin: "human", start, end: start + HOUR, models: [], projectKey });
    const evs: Ev[] = [cov,
      session("codex:b", T0, "kB"), { k: "codex-thread-row", tool: "codex", source: "codex.threads", threadId: "codex:b", createdAt: T0 },
      session("codex:a-old", T0 + DAY, "kA"), { k: "codex-rollout", tool: "codex", source: "codex.rollouts", threadId: "codex:a-old", fileTs: T0 + DAY, uuidTs: T0 + DAY },
      session("codex:a", T0 + 2 * DAY, "kA"), { k: "codex-rollout", tool: "codex", source: "codex.rollouts", threadId: "codex:a", fileTs: T0 + 2 * DAY, uuidTs: T0 + 2 * DAY },
      { k: "codex-thread-row", tool: "codex", source: "codex.threads", threadId: "codex:a", createdAt: T0 + 2 * DAY },
    ];
    const withB = scanResultOf(evs, { finishedAt: NOW });
    const withoutB = scanResultOf(evs.filter((e) => !("threadId" in e && e.threadId === "codex:b") && !(e.k === "session" && e.id === "codex:b")), { finishedAt: NOW });
    const excluded = byId(run(withB, { projects: ["kB"] }), "C6");
    expect(excluded).toEqual(byId(run(withoutB), "C6"));
    // one rollout checked, none missing: too few for a pass
    expect([excluded.status, excluded.reason, excluded.n, excluded.values.beforeIndex]).toEqual(["n/a", "too-few", 1, 1]);
  });
});
