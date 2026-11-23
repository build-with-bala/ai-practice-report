import { describe, expect, test } from "bun:test";
import { buildSessionTable } from "../../../core/analysis/sessions";
import { checkAccount, checkClaudeHistory } from "../../../core/forensics/claude";
import type { DailyEv, Ev, IdentityEv, PromptEv, SessionEv } from "../../../core/model/events";
import { scanResultOf } from "../../kit/scanresult";

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
    const c = checkClaudeHistory(raw, t);
    expect(c.id).toBe("C3");
    expect(c.status).toBe("pass");
    expect(c.values.matchShare).toBe(0.9);
    expect(c.n).toBe(10);
    expect(c.tools).toEqual(["claude-code"]);
  });

  test("6 of 10 in history warn", () => {
    const { raw, t } = tableOf(promptsWithHistory(6));
    const c = checkClaudeHistory(raw, t);
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
    expect(checkClaudeHistory(raw, t).values.matchShare).toBe(0.6);
  });

  test("only prompts inside the history's span count", () => {
    const evs: Ev[] = [sess("s", T0), hPrompt(T0 - 5_000, "p0"), hPrompt(T0 + DAY + 5_000, "p1")];
    for (let i = 0; i < 10; i++) evs.push(tPrompt("s", T0 + i * DAY, `p${i}`));
    const { raw, t } = tableOf(evs);
    const c = checkClaudeHistory(raw, t);
    expect(c.status).toBe("pass");
    expect(c.n).toBe(2);
  });

  test("non-human transcript prompts are left out", () => {
    const evs = promptsWithHistory(9);
    for (let i = 0; i < 10; i++) evs.push(tPrompt("s", T0 + i * DAY + 1_000, `x${i}`, { origin: "system" }));
    const { raw, t } = tableOf(evs);
    expect(checkClaudeHistory(raw, t).values.matchShare).toBe(0.9);
  });

  test("3 transcript days missing from the stats span fail", () => {
    const evs = promptsWithHistory(10);
    for (let i = 0; i < 10; i++) if (i < 2 || i > 4) evs.push(stats(day(T0 + i * DAY)));
    const { raw, t } = tableOf(evs);
    const c = checkClaudeHistory(raw, t);
    expect(c.status).toBe("fail");
    expect(c.values.missingDays).toBe(3);
    expect(c.askAbout).toContain("3 days");
  });

  test("a single missing day is a note", () => {
    const evs = promptsWithHistory(10);
    for (let i = 0; i < 10; i++) if (i !== 4) evs.push(stats(day(T0 + i * DAY)));
    const { raw, t } = tableOf(evs);
    const c = checkClaudeHistory(raw, t);
    expect(c.status).toBe("note");
    expect(c.values.missingDays).toBe(1);
  });

  test("a day after the stats span is not counted", () => {
    const evs = promptsWithHistory(10);
    for (let i = 0; i < 7; i++) evs.push(stats(day(T0 + i * DAY)));
    const { raw, t } = tableOf(evs);
    const c = checkClaudeHistory(raw, t);
    expect(c.status).toBe("pass");
    expect(c.values.missingDays).toBe(0);
  });

  test("days are UTC days", () => {
    // 23:30 UTC: the next day in Auckland, the same day in UTC
    const ts = Date.UTC(2026, 9, 7, 23, 30);
    const evs: Ev[] = [sess("s", ts), tPrompt("s", ts, "p"), stats("2026-10-06"), stats("2026-10-07"), stats("2026-10-09")];
    const raw = scanResultOf(evs);
    const t = buildSessionTable(raw, { now: raw.finishedAt, timeZone: "Pacific/Auckland" });
    expect(checkClaudeHistory(raw, t).values.missingDays).toBe(0);
  });

  test("n/a when either side is empty", () => {
    const none = tableOf([hPrompt(T0, "p"), stats(day(T0))]);
    expect(checkClaudeHistory(none.raw, none.t).status).toBe("n/a");
    const alone = tableOf([sess("s", T0), tPrompt("s", T0, "p")]);
    expect(checkClaudeHistory(alone.raw, alone.t).status).toBe("n/a");
  });
});

const ident = (scope: IdentityEv["scope"], hash: string, sessionId?: string): IdentityEv =>
  ({ k: "identity", tool: "claude-code", source: scope === "config" ? "claude-code.config" : "claude-code.transcripts", scope, hash, sessionId });

describe("checkAccount (C4)", () => {
  test("matching hashes pass", () => {
    const c = checkAccount(scanResultOf([ident("config", "a"), ident("session", "a", "s1"), ident("session", "a", "s2")]));
    expect(c.id).toBe("C4");
    expect(c.status).toBe("pass");
    expect(c.values).toEqual({ matchShare: 1, accounts: 1 });
    expect(c.n).toBe(2);
  });

  test("no match fails", () => {
    const c = checkAccount(scanResultOf([ident("config", "a"), ident("session", "b", "s1")]));
    expect(c.status).toBe("fail");
    expect(c.values.matchShare).toBe(0);
    expect(c.askAbout).toBeString();
  });

  test("2 session accounts are a note", () => {
    const c = checkAccount(scanResultOf([ident("config", "a"), ident("session", "a", "s1"), ident("session", "b", "s2")]));
    expect(c.status).toBe("note");
    expect(c.values.accounts).toBe(2);
    expect(c.askAbout).toContain("2 ");
  });

  test("n/a when either side is missing", () => {
    expect(checkAccount(scanResultOf([ident("config", "a")])).status).toBe("n/a");
    expect(checkAccount(scanResultOf([ident("session", "a", "s1")])).status).toBe("n/a");
    expect(checkAccount(scanResultOf([])).status).toBe("n/a");
  });
});
