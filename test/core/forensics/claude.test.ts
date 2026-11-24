import { describe, expect, test } from "bun:test";
import { dayKey, dayStart } from "../../../core/analysis/activity";
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

/**
 * 20 transcript prompts, two a day over 10 days (a pass needs 20 compared); those of the first `inHistory` days also in
 * history (5 s later), the span held open by two more.
 */
function promptsWithHistory(inHistory: number): Ev[] {
  const evs: Ev[] = [sess("s", T0)];
  for (let i = 0; i < 10; i++) {
    for (const [k, ts] of [T0 + i * DAY, T0 + i * DAY + 3_600_000].entries()) {
      evs.push(tPrompt("s", ts, `p${i}-${k}`));
      if (i < inHistory) evs.push(hPrompt(ts + 5_000, `p${i}-${k}`));
    }
  }
  evs.push(hPrompt(T0 - DAY, "early"), hPrompt(T0 + 12 * DAY, "late"));
  return evs;
}

describe("checkClaudeHistory (C3)", () => {
  test("18 of 20 transcript prompts in history pass", () => {
    const { raw, t } = tableOf(promptsWithHistory(9));
    const c = historyOf(raw, t);
    expect(c.id).toBe("C3");
    expect(c.status).toBe("pass");
    expect(c.values.matchShare).toBe(0.9);
    expect(c.n).toBe(20);
    expect(c.tools).toEqual(["claude-code"]);
  });

  test("12 of 20 in history warn", () => {
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

  test("only prompts inside the history's span count; a pass on 2 compared prompts is too few", () => {
    const evs: Ev[] = [sess("s", T0), hPrompt(T0 - 5_000, "p0"), hPrompt(T0 + DAY + 5_000, "p1")];
    for (let i = 0; i < 10; i++) evs.push(tPrompt("s", T0 + i * DAY, `p${i}`));
    const { raw, t } = tableOf(evs);
    const c = historyOf(raw, t);
    expect([c.status, c.reason, c.n, c.values.matchShare]).toEqual(["n/a", "too-few", 2, 1]);
  });

  test("a pass needs 20 compared prompts; a warn stands on fewer", () => {
    const few = (n: number, inHistory: number): Ev[] => {
      const evs: Ev[] = [sess("s", T0), hPrompt(T0 - DAY, "early"), hPrompt(T0 + 40 * DAY, "late")];
      for (let i = 0; i < n; i++) {
        evs.push(tPrompt("s", T0 + i * DAY, `q${i}`));
        if (i < inHistory) evs.push(hPrompt(T0 + i * DAY + 5_000, `q${i}`));
      }
      return evs;
    };
    const at = (evs: Ev[]) => { const { raw, t } = tableOf(evs); return historyOf(raw, t); };
    expect([at(few(19, 19)).status, at(few(19, 19)).reason]).toEqual(["n/a", "too-few"]);
    expect(at(few(20, 20)).status).toBe("pass");
    expect(at(few(4, 1)).status).toBe("warn");
  });

  test("non-human transcript prompts are left out", () => {
    const evs = promptsWithHistory(9);
    for (let i = 0; i < 10; i++) evs.push(tPrompt("s", T0 + i * DAY + 1_000, `x${i}`, { origin: "system" }));
    expect(historyOf(tableOf(evs).raw, tableOf(evs).t).n).toBe(20);
    const { raw, t } = tableOf(evs);
    expect(historyOf(raw, t).values.matchShare).toBe(0.9);
  });

  test("2 transcript days missing from the stats span, neither with a neighbour in it, warn, never fail", () => {
    const evs = promptsWithHistory(10);
    for (let i = 0; i < 10; i++) if (i === 0 || i === 4 || i === 5 || i === 9) evs.push(stats(day(T0 + i * DAY)));
    const { raw, t } = tableOf(evs);
    const c = historyOf(raw, t);
    expect(c.status).toBe("warn");
    expect(c.values.missingDays).toBe(2);
    expect(c.askAbout).toContain("2 days");
    expect(c.askAbout).toContain("made on another machine");
  });

  test("a single missing day is a note", () => {
    const evs = promptsWithHistory(10);
    for (let i = 0; i < 10; i++) if (i < 3 || i > 5) evs.push(stats(day(T0 + i * DAY)));
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

  test("transcript days are UTC days, whatever the analysis zone", () => {
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
    const statsOnly: Ev[] = [sess("s", T0), ...Array.from({ length: 20 }, (_, i) => tPrompt("s", T0 + i * MIN, `p${i}`)), stats(day(T0))];
    const s = tableOf(statsOnly);
    const c = historyOf(s.raw, s.t);
    expect([c.status, c.reason, c.n]).toEqual(["pass", "ok-stats-only", 1]);
    const one = tableOf([sess("s", T0), tPrompt("s", T0, "p"), stats(day(T0))]);
    expect([historyOf(one.raw, one.t).status, historyOf(one.raw, one.t).reason]).toEqual(["n/a", "too-few"]);
    const both = tableOf([...promptsWithHistory(10), ...Array.from({ length: 10 }, (_, i) => stats(day(T0 + i * DAY)))]);
    expect(historyOf(both.raw, both.t).reason).toBe("ok");
  });
});

describe("checkClaudeHistory (C3): the stats cache's day may be the UTC day or the local one", () => {
  const HOUR = 3_600_000;
  /**
   * A weekday worker over four weeks in `zone`, one prompt every 30 min from `from` to `to` local hours, in one
   * session a day; and the stats cache's days for those prompts, keyed by `key` (each prompt's local day, its UTC day,
   * or UTC in the first two weeks and local after, as a cache written before and after the tool changed its key).
   */
  function worker(zone: string, key: "local" | "utc" | "mixed", from = 9, to = 18): Ev[] {
    const evs: Ev[] = [];
    const statsDays = new Set<string>();
    const first = Date.UTC(2026, 8, 7); // a Monday
    for (let d = 0; d < 28; d++) {
      const date = new Date(first + d * DAY);
      if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
      const local = date.toISOString().slice(0, 10);
      const start = dayStart(local, zone);
      const id = `s${d}`;
      evs.push({ ...sess(id, start + from * HOUR), end: start + to * HOUR });
      for (let ts = start + from * HOUR; ts < start + to * HOUR; ts += 30 * MIN) {
        evs.push(tPrompt(id, ts, `p${d}-${ts}`));
        const utc = key === "utc" || (key === "mixed" && d < 14);
        statsDays.add(utc ? day(ts) : dayKey(ts, zone));
      }
    }
    for (const s of statsDays) evs.push(stats(s));
    return evs;
  }

  for (const [zone, from, to] of [["America/Los_Angeles", 9, 18], ["Australia/Sydney", 9, 18], ["Pacific/Auckland", 9, 18], ["America/New_York", 9, 22]] as const) {
    for (const key of ["local", "utc", "mixed"] as const) {
      test(`an honest weekday worker in ${zone}, ${from} to ${to}, with the cache keyed ${key}, passes`, () => {
        const { raw, t } = tableOf(worker(zone, key, from, to));
        const c = historyOf(raw, t);
        expect([c.status, c.reason, c.values.missingDays]).toEqual(["pass", "ok-stats-only", 0]);
      });
    }
  }

  /** A prompt every 2 h on each of 30 days, UTC-keyed stats for every day but those in `gone`. */
  const daily = (gone: number[]): Ev[] => {
    const evs: Ev[] = [sess("s", T0)];
    for (let d = 0; d < 30; d++) {
      for (let h = 0; h < 4; h++) evs.push(tPrompt("s", T0 + d * DAY + h * 2 * HOUR, `p${d}-${h}`));
      if (!gone.includes(d)) evs.push(stats(day(T0 + d * DAY)));
    }
    return evs;
  };

  test("a day missing with both neighbours present counts as present", () => {
    const { raw, t } = tableOf(daily([5, 12]));
    expect(historyOf(raw, t).values.missingDays).toBe(0);
  });

  test("a day truly missing, with no neighbour in the cache, still counts as missing", () => {
    const one = tableOf(daily([5, 6, 7]));
    expect([historyOf(one.raw, one.t).status, historyOf(one.raw, one.t).values.missingDays]).toEqual(["note", 1]);
    const two = tableOf(daily([5, 6, 7, 15, 16, 17]));
    expect([historyOf(two.raw, two.t).status, historyOf(two.raw, two.t).values.missingDays]).toEqual(["warn", 2]);
  });

  test("the day's zone label is not read: a stats day labelled local counts like one labelled utc", () => {
    const evs = daily([5, 6, 7]).map((e) => (e.k === "daily" ? { ...e, zone: "local" as const } : e));
    const { raw, t } = tableOf(evs);
    expect([historyOf(raw, t).status, historyOf(raw, t).values.missingDays]).toEqual(["note", 1]);
  });
});

const ident = (scope: IdentityEv["scope"], hash: string, sessionId?: string): IdentityEv =>
  ({ k: "identity", tool: "claude-code", source: scope === "config" ? "claude-code.config" : "claude-code.transcripts", scope, hash, sessionId });

/** The sessions the session-scope hashes name: a hash whose session has no row is out of scope. */
const sessions = [sess("s1", T0), sess("s2", T0), sess("s3", T0), sess("s4", T0), sess("s5", T0)];
const five = (hash: string) => ["s1", "s2", "s3", "s4", "s5"].map((id) => ident("session", hash, id));

describe("checkAccount (C4)", () => {
  test("matching hashes pass", () => {
    const c = accountOf(scanResultOf([...sessions, ident("config", "a"), ...five("a")]));
    expect(c.id).toBe("C4");
    expect(c.status).toBe("pass");
    expect(c.values).toEqual({ matchShare: 1, accounts: 1 });
    expect(c.n).toBe(5);
    const four = accountOf(scanResultOf([...sessions, ident("config", "a"), ...five("a").slice(0, 4)]));
    expect([four.status, four.reason, four.n]).toEqual(["n/a", "too-few", 4]);
  });

  test("no match is a warn asking whether the person changed accounts, never a fail", () => {
    const c = accountOf(scanResultOf([...sessions, ident("config", "a"), ident("session", "b", "s1")]));
    expect([c.status, c.reason]).toEqual(["warn", "no-match"]);
    expect(c.values.matchShare).toBe(0);
    expect(c.askAbout).toContain("change accounts");
  });

  test("2 session accounts are a note", () => {
    const c = accountOf(scanResultOf([...sessions, ident("config", "a"), ident("session", "a", "s1"), ident("session", "b", "s2")]));
    expect(c.status).toBe("note");
    expect(c.values.accounts).toBe(2);
    expect(c.askAbout).toContain("2 ");
  });

  test("a session hash whose session has no row is out of scope; one naming no session counts", () => {
    const orphan = accountOf(scanResultOf([...sessions, ident("config", "a"), ...five("a"), ident("session", "b", "gone")]));
    expect([orphan.status, orphan.n]).toEqual(["pass", 5]);
    const bare = accountOf(scanResultOf([...sessions, ident("config", "a"), ident("session", "a", "s1"), ident("session", "b")]));
    expect([bare.status, bare.n]).toEqual(["note", 2]);
  });

  test("n/a when either side is missing", () => {
    expect(accountOf(scanResultOf([ident("config", "a")])).status).toBe("n/a");
    expect(accountOf(scanResultOf([ident("session", "a", "s1")])).status).toBe("n/a");
    expect(accountOf(scanResultOf([])).status).toBe("n/a");
  });
});
