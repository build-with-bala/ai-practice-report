import { describe, expect, test } from "bun:test";
import type { Exclusions } from "../../../core/analysis/types";
import { runForensics, type Forensics } from "../../../core/forensics";
import type { CheckId, CheckResult } from "../../../core/forensics/types";
import type { ScanResult } from "../../../core/scan";
import { tableOf } from "./table";
import { MID, NOW, scanOf, TABLE, world, type Tagged } from "./world";

/*
 * Every check and soft flag reads in-scope data only. Excluding a slice of the world must give, check by check, what
 * the same world without that slice gives: the excluded data reaches no check. Sessionless events (anchors, file facts,
 * thread rows, usage-limit readings, history prompts without a session) cannot be tied to a project, so a project
 * exclusion leaves them in.
 */

const run = (raw: ScanResult, exclude?: Exclusions): Forensics => runForensics(raw, tableOf(raw, exclude), [], { now: NOW, timeZone: "UTC", releases: TABLE });
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
    // the history keeps its sessionless echoes of project B's prompts, so B's days stay active: recent-burst stays
    changes: ["C3", "C4", "C6", "C7", "C9", "C10", "soft:rhythm", "soft:repeated-long", "soft:unclosed-tools", "soft:new-config"] },
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
    expect(run(raw, { tools: ["cursor"] })).toEqual(run(raw));
  });
});
