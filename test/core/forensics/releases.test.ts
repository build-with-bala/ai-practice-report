import { describe, expect, test } from "bun:test";
import { buildSessionTable } from "../../../core/analysis/sessions";
import { checkReleases, RELEASES, type ReleaseTable } from "../../../core/forensics/releases";
import type { Ev, SessionEv, TurnEv, UsageEv } from "../../../core/model/events";
import type { ToolId } from "../../../core/model/ids";
import { scanResultOf } from "../../kit/scanresult";
import { asks } from "./table";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const RELEASED = Date.UTC(2026, 5, 10);
const TABLE: ReleaseTable = {
  version: 1,
  models: [
    { match: "^model-x(-\\d{8})?$", released: "2026-06-10", source: "https://example.com/x" },
    { match: "^model-", released: "2020-01-01", source: "https://example.com/any" },
  ],
  tools: { codex: [{ version: "9.1.0", released: "2026-06-10", source: "https://example.com/v" }] },
};
const sess = (id: string, start: number, over: Partial<SessionEv> = {}): SessionEv => ({
  k: "session", tool: "claude-code", source: "claude-code.transcripts", id, window: "detail", origin: "human", start, end: start + 3_600_000,
  models: [], ...over,
});
const turn = (sessionId: string, ts: number, model: string): TurnEv =>
  ({ k: "turn", tool: "claude-code", source: "claude-code.transcripts", ts, sessionId, window: "detail", model });
const usage = (sessionId: string, ts: number, model: string): UsageEv =>
  ({ k: "usage", tool: "claude-code", source: "claude-code.transcripts", ts, sessionId, model, inTok: 1, outTok: 1, cacheR: 0, cacheW: 0 });
const check = (events: Ev[], table: ReleaseTable = TABLE) => {
  const raw = scanResultOf(events);
  return asks(checkReleases(buildSessionTable(raw, { timeZone: "UTC" }), table, raw));
};

describe("checkReleases (C9)", () => {
  test("a model used 5 days before its release is a warn asking about early access", () => {
    const c = check([sess("a", RELEASED - 5 * DAY, { models: ["model-x-20260601"] }), sess("b", RELEASED + DAY, { models: ["model-x"] })]);
    expect(c.id).toBe("C9");
    expect([c.status, c.reason]).toEqual(["warn", "before-release"]);
    expect(c.values).toEqual({ checked: 2, violations: 1, sessions: 1, longBefore: 0 });
    expect(c.n).toBe(2);
    expect(c.tools).toEqual(["claude-code"]);
    expect(c.askAbout).toBe("1 session used a model or tool version more than 2 days before its public release. Did you have early access to it?");
  });

  test("fail needs max(3, 1% of the dated sessions) more than 90 days before the release", () => {
    const early = (n: number, total: number, days = 100) => Array.from({ length: total }, (_, i) =>
      sess(`s${i}`, i < n ? RELEASED - days * DAY : RELEASED + DAY, { models: ["model-x"] }));
    // a private early-access period can be longer than 30 days: 60 days early is a warn, never a fail
    expect([check(early(5, 10, 60)).status, check(early(5, 10, 60)).reason]).toEqual(["warn", "before-release"]);
    const two = check(early(2, 10));
    expect([two.status, two.reason]).toEqual(["warn", "before-release"]);
    const three = check(early(3, 10));
    expect([three.status, three.reason, three.values.longBefore]).toEqual(["fail", "long-before-release", 3]);
    expect(three.askAbout).toBe("3 sessions used a model or tool version more than 90 days before its public release. Were session times edited, or did you have early access to it?");
    expect(check(early(3, 400)).status).toBe("warn");
    expect(check([sess("a", RELEASED - 20 * DAY, { models: ["model-x"] }), sess("b", RELEASED - 20 * DAY, { models: ["model-x"] }),
      sess("c", RELEASED - 20 * DAY, { models: ["model-x"] })]).status).toBe("warn");
  });

  test("a model used 1 day before its release passes", () => {
    const c = check([sess("a", RELEASED - DAY, { models: ["model-x"] })]);
    expect([c.status, c.reason]).toEqual(["pass", "ok"]);
    expect(c.askAbout).toBeUndefined();
  });

  test("a resumed session: started 10 days before the release, the new model first used after it, passes", () => {
    const start = RELEASED - 10 * DAY;
    const c = check([sess("r", start, { end: RELEASED + 5 * DAY, models: ["old-m", "model-x"] }),
      turn("r", start + HOUR, "old-m"), usage("r", RELEASED + 4 * DAY, "model-x"), turn("r", RELEASED + 5 * DAY, "model-x")]);
    expect([c.status, c.reason]).toEqual(["pass", "ok"]);
    expect(c.values.checked).toBe(1);   // "old-m" is not in the table
  });

  test("a model first used 5 days before its release is still a violation, though the session ends after it", () => {
    const start = RELEASED - 10 * DAY;
    const c = check([sess("r", start, { end: RELEASED + 5 * DAY, models: ["model-x"] }),
      turn("r", RELEASED - 5 * DAY, "model-x"), turn("r", RELEASED + 4 * DAY, "model-x")]);
    expect(c.status).toBe("warn");
  });

  test("a model no event carries is compared with the row's end", () => {
    const start = RELEASED - 10 * DAY;
    expect(check([sess("r", start, { end: RELEASED - DAY, models: ["model-x"] })]).status).toBe("pass");
    expect(check([sess("r", start, { end: RELEASED - 3 * DAY, models: ["model-x"] })]).status).toBe("warn");
  });

  test("a model takes the first entry that matches", () => {
    // "model-x" matches the first entry (2026), so a 2025 session is a violation although the second entry (2020) would pass it
    expect(check([sess("a", Date.UTC(2025, 0, 1), { models: ["model-x"] })]).status).toBe("warn");
    expect(check([sess("a", Date.UTC(2025, 0, 1), { models: ["model-y"] })]).status).toBe("pass");
  });

  test("a tool version matches its tool's exact entry only", () => {
    const codex = (version: string, tool: ToolId = "codex") => sess("c", RELEASED - 5 * DAY, { tool, source: `${tool}.x`, version });
    expect(check([codex("9.1.0")]).status).toBe("warn");
    expect(check([codex("9.1.0")]).tools).toEqual(["codex"]);
    expect(check([codex("9.1.1")]).status).toBe("n/a");
    expect(check([codex("9.1.0", "cursor")]).status).toBe("n/a");
  });

  test("nothing matching is n/a; an unlisted model is not checked", () => {
    const c = check([sess("a", RELEASED - 50 * DAY, { models: ["other"] }), sess("b", RELEASED)]);
    expect([c.status, c.reason, c.n]).toEqual(["n/a", "no-match", 0]);
  });

  test("the shipped table is well-formed: valid patterns, real dates, public sources", () => {
    expect(RELEASES.version).toBeGreaterThanOrEqual(1);
    expect(RELEASES.models.length).toBeGreaterThan(0);
    const entries = [...RELEASES.models, ...Object.values(RELEASES.tools).flat()];
    for (const e of entries) {
      expect(e.released).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${e.released}T00:00:00Z`).toISOString().slice(0, 10)).toBe(e.released);
      expect(e.source).toMatch(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\//);
    }
    for (const m of RELEASES.models) expect(() => new RegExp(m.match)).not.toThrow();
    // anchored at both ends: a pattern never matches inside a longer, other model id
    for (const m of RELEASES.models) expect([m.match, m.match.startsWith("^") && m.match.endsWith("$")]).toEqual([m.match, true]);
  });

  test("the result names no model: counts only", () => {
    const c = check([sess("a", RELEASED - 5 * DAY, { models: ["model-x"] })]);
    expect(JSON.stringify(c)).not.toContain("model-x");
    for (const v of Object.values(c.values)) expect(typeof v).toBe("number");
    expect(`${c.reason}${c.askAbout ?? ""}`).toMatch(/^[ -ÿ -⁯−]*$/);
  });
});
