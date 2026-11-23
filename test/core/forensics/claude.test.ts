import { describe, expect, test } from "bun:test";
import { buildSessionTable } from "../../../core/analysis/sessions";
import type { SessionTable } from "../../../core/analysis/types";
import { checkAccount, checkClaudeHistory } from "../../../core/forensics/claude";
import type { DailyEv, Ev, IdentityEv, PromptEv, SessionEv } from "../../../core/model/events";
import type { ScanResult } from "../../../core/scan";
import { scanResultOf } from "../../kit/scanresult";
import { asks, tableOf as tableOfRaw } from "./table";

const accountOf = (raw: ScanResult) => asks(checkAccount(raw, tableOfRaw(raw)));
const historyOf = (raw: ScanResult, t: SessionTable) => asks(checkClaudeHistory(raw, t));

const T0 = Date.UTC(2026, 9, 5, 9, 0);
const MIN = 60_000;
const DAY = 86_400_000;

const sess = (id: string, start: number): SessionEv => ({
  k: "session", tool: "claude-code", source: "claude-code.transcripts", id, window: "detail", origin: "human",
  start, end: start + 30 * MIN, models: [],
});
const features = { words: 5, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: false, techCats: {} } as const;
const tPrompt = (sessionId: string, ts: number, textHash: string, over: Partial<PromptEv> = {}): PromptEv => ({
  k: "prompt", tool: "claude-code", source: "claude-code.transcripts", ts, sessionId, window: "detail", origin: "human",
  intent: "spec", textHash, features, ...over,
});
const hPrompt = (ts: number, textHash: string): PromptEv => ({
  k: "prompt", tool: "claude-code", source: "claude-code.history", ts, window: "lifetime", origin: "human", intent: "spec", textHash, features,
});
const stats = (day: string): DailyEv => ({ k: "daily", tool: "claude-code", source: "claude-code.stats", day, zone: "utc", unit: "messages", count: 10 });
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const tableOf = (events: Ev[]) => {
  const raw = scanResultOf(events);
  return { raw, t: buildSessionTable(raw, { now: raw.finishedAt, timeZone: "UTC" }) };
};

/** 10 transcript prompts, one per day; the first `inHistory` also in history (5 s later), the span held open by two more. */
function promptsWithHistory(inHistory: number): Ev[] {
  const evs: Ev[] = [sess("s", T0)];
  for (let i = 0; i < 10; i++) {
    const ts = T0 + i * DAY;
    evs.push(tPrompt("s", ts, `p${i}`));
    if (i < inHistory) evs.push(hPrompt(ts + 5_000, `p${i}`));
  }
  evs.push(hPrompt(T0 - DAY, "early"), hPrompt(T0 + 12 * DAY, "late"));
  return evs;
}

describe("checkClaudeHistory (C3)", () => {
  test("9 of 10 transcript prompts in history pass", () => {
    const { raw, t } = tableOf(promptsWithHistory(9));
    const c = historyOf(raw, t);
    expect(c.id).toBe("C3");
    expect(c.status).toBe("pass");
    expect(c.values.matchShare).toBe(0.9);
    expect(c.n).toBe(10);
    expect(c.tools).toEqual(["claude-code"]);
  });

  test("6 of 10 in history warn", () => {
    const { raw, t } = tableOf(promptsWithHistory(6));
    const c = historyOf(raw, t);
    expect(c.status).toBe("warn");
    expect(c.values.matchShare).toBe(0.6);
    expect(c.askAbout).toBeString();
  });

  test("a history entry more than 10 s away, or with another text hash, is no match", () => {
    const evs: Ev[] = [sess("s", T0), hPrompt(T0 - DAY, "early"), hPrompt(T0 + 12 * DAY, "late")];
    for (let i = 0; i < 10; i++) {
      evs.push(tPrompt("s", T0 + i * DAY, `p${i}`));
      evs.push(hPrompt(T0 + i * DAY + (i < 3 ? 11_000 : 0), i === 3 ? "other" : `p${i}`));
    }
    const { raw, t } = tableOf(evs);
    expect(historyOf(raw, t).values.matchShare).toBe(0.6);
  });

  test("only prompts inside the history's span count", () => {
    const evs: Ev[] = [sess("s", T0), hPrompt(T0 - 5_000, "p0"), hPrompt(T0 + DAY + 5_000, "p1")];
    for (let i = 0; i < 10; i++) evs.push(tPrompt("s", T0 + i * DAY, `p${i}`));
    const { raw, t } = tableOf(evs);
    const c = historyOf(raw, t);
    expect(c.status).toBe("pass");
    expect(c.n).toBe(2);
  });

  test("non-human transcript prompts are left out", () => {
    const evs = promptsWithHistory(9);
    for (let i = 0; i < 10; i++) evs.push(tPrompt("s", T0 + i * DAY + 1_000, `x${i}`, { origin: "system" }));
    const { raw, t } = tableOf(evs);
    expect(historyOf(raw, t).values.matchShare).toBe(0.9);
  });

  test("3 transcript days missing from the stats span fail", () => {
    const evs = promptsWithHistory(10);
    for (let i = 0; i < 10; i++) if (i < 2 || i > 4) evs.push(stats(day(T0 + i * DAY)));
    const { raw, t } = tableOf(evs);
    const c = historyOf(raw, t);
    expect(c.status).toBe("fail");
    expect(c.values.missingDays).toBe(3);
    expect(c.askAbout).toContain("3 days");
  });

  test("a single missing day is a note", () => {
    const evs = promptsWithHistory(10);
    for (let i = 0; i < 10; i++) if (i !== 4) evs.push(stats(day(T0 + i * DAY)));
    const { raw, t } = tableOf(evs);
    const c = historyOf(raw, t);
    expect(c.status).toBe("note");
    expect(c.values.missingDays).toBe(1);
  });

  test("a day after the stats span is not counted", () => {
    const evs = promptsWithHistory(10);
    for (let i = 0; i < 7; i++) evs.push(stats(day(T0 + i * DAY)));
    const { raw, t } = tableOf(evs);
    const c = historyOf(raw, t);
    expect(c.status).toBe("pass");
    expect(c.values.missingDays).toBe(0);
  });

  test("days are UTC days", () => {
    // 23:30 UTC: the next day in Auckland, the same day in UTC
    const ts = Date.UTC(2026, 9, 7, 23, 30);
    const evs: Ev[] = [sess("s", ts), tPrompt("s", ts, "p"), stats("2026-10-06"), stats("2026-10-07"), stats("2026-10-09")];
    const raw = scanResultOf(evs);
    const t = buildSessionTable(raw, { now: raw.finishedAt, timeZone: "Pacific/Auckland" });
    expect(historyOf(raw, t).values.missingDays).toBe(0);
  });

  test("n/a when either side is empty", () => {
    const none = tableOf([hPrompt(T0, "p"), stats(day(T0))]);
    expect(historyOf(none.raw, none.t).status).toBe("n/a");
    const alone = tableOf([sess("s", T0), tPrompt("s", T0, "p")]);
    expect(historyOf(alone.raw, alone.t).status).toBe("n/a");
  });
});

describe("checkClaudeHistory (C3): pasted prompts and one-part results", () => {
  const pasted = (ts: number, sessionId?: string): PromptEv => ({ ...hPrompt(ts, "placeholder"), hasPaste: true, ...(sessionId ? { sessionId } : {}) });
  const span = [hPrompt(T0 - DAY, "early"), hPrompt(T0 + DAY, "late")];

  test("a pasted prompt matches a hasPaste history entry by time", () => {
    const { raw, t } = tableOf([sess("s", T0), tPrompt("s", T0, "typed-with-paste"), pasted(T0 + 3_000, "s"), ...span]);
    expect(historyOf(raw, t).values.matchShare).toBe(1);
  });

  test("a second transcript prompt cannot reuse the same history entry", () => {
    const { raw, t } = tableOf([sess("s", T0), tPrompt("s", T0, "a"), tPrompt("s", T0 + 2_000, "b"), pasted(T0 + 1_000, "s"), ...span]);
    expect(historyOf(raw, t).values.matchShare).toBe(0.5);
  });

  test("pasted entries are matched one to one at the maximum: entries at 0 s and 9 s, prompts at 5 s and 15 s", () => {
    const { raw, t } = tableOf([sess("s", T0), tPrompt("s", T0 + 5_000, "a"), tPrompt("s", T0 + 15_000, "b"), pasted(T0, "s"), pasted(T0 + 9_000, "s"), ...span]);
    expect(historyOf(raw, t).values.matchShare).toBe(1);
  });

  test("a hasPaste entry in another session does not match", () => {
    const { raw, t } = tableOf([sess("s", T0), tPrompt("s", T0, "a"), pasted(T0 + 1_000, "other"), ...span]);
    expect(historyOf(raw, t).values.matchShare).toBe(0);
  });

  test("a pass says which parts ran", () => {
    const history = tableOf(promptsWithHistory(10));
    expect(historyOf(history.raw, history.t).reason).toBe("ok-history-only");
    const statsOnly: Ev[] = [sess("s", T0), tPrompt("s", T0, "p"), stats(day(T0))];
    const s = tableOf(statsOnly);
    const c = historyOf(s.raw, s.t);
    expect([c.status, c.reason, c.n]).toEqual(["pass", "ok-stats-only", 1]);
    const both = tableOf([...promptsWithHistory(10), ...Array.from({ length: 10 }, (_, i) => stats(day(T0 + i * DAY)))]);
    expect(historyOf(both.raw, both.t).reason).toBe("ok");
  });

  test("only utc stats days are read", () => {
    const evs: Ev[] = [sess("s", T0), tPrompt("s", T0, "p"), tPrompt("s", T0 + 2 * DAY, "q"), tPrompt("s", T0 + 4 * DAY, "r"),
      stats(day(T0)), stats(day(T0 + 4 * DAY)), { ...stats(day(T0 + 2 * DAY)), zone: "local" }];
    const { raw, t } = tableOf(evs);
    expect(historyOf(raw, t).values.missingDays).toBe(1);
  });
});

const ident = (scope: IdentityEv["scope"], hash: string, sessionId?: string): IdentityEv =>
  ({ k: "identity", tool: "claude-code", source: scope === "config" ? "claude-code.config" : "claude-code.transcripts", scope, hash, sessionId });

/** The sessions the session-scope hashes name: a hash whose session has no row is out of scope. */
const sessions = [sess("s1", T0), sess("s2", T0)];

describe("checkAccount (C4)", () => {
  test("matching hashes pass", () => {
    const c = accountOf(scanResultOf([...sessions, ident("config", "a"), ident("session", "a", "s1"), ident("session", "a", "s2")]));
    expect(c.id).toBe("C4");
    expect(c.status).toBe("pass");
    expect(c.values).toEqual({ matchShare: 1, accounts: 1 });
    expect(c.n).toBe(2);
  });

  test("no match fails", () => {
    const c = accountOf(scanResultOf([...sessions, ident("config", "a"), ident("session", "b", "s1")]));
    expect(c.status).toBe("fail");
    expect(c.values.matchShare).toBe(0);
    expect(c.askAbout).toBeString();
  });

  test("2 session accounts are a note", () => {
    const c = accountOf(scanResultOf([...sessions, ident("config", "a"), ident("session", "a", "s1"), ident("session", "b", "s2")]));
    expect(c.status).toBe("note");
    expect(c.values.accounts).toBe(2);
    expect(c.askAbout).toContain("2 ");
  });

  test("a session hash whose session has no row is out of scope; one naming no session counts", () => {
    const orphan = accountOf(scanResultOf([...sessions, ident("config", "a"), ident("session", "a", "s1"), ident("session", "b", "gone")]));
    expect([orphan.status, orphan.n]).toEqual(["pass", 1]);
    const bare = accountOf(scanResultOf([...sessions, ident("config", "a"), ident("session", "a", "s1"), ident("session", "b")]));
    expect([bare.status, bare.n]).toEqual(["note", 2]);
  });

  test("n/a when either side is missing", () => {
    expect(accountOf(scanResultOf([ident("config", "a")])).status).toBe("n/a");
    expect(accountOf(scanResultOf([ident("session", "a", "s1")])).status).toBe("n/a");
    expect(accountOf(scanResultOf([])).status).toBe("n/a");
  });
});
