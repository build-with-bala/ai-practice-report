import { describe, expect, test } from "bun:test";
import type { SessionEv, ToolEv } from "../../../core/model/events";
import { sid, type Origin, type Window } from "../../../core/model/ids";
import { EventStore, mergeSessions } from "../../../core/model/store";

const sess = (over: Partial<SessionEv>): SessionEv => ({
  k: "session", tool: "codex", source: "t", id: "x", window: "detail", origin: "human",
  start: 10, end: 20, models: ["a"], ...over,
});
const tool = (sessionId: string, ts: number): ToolEv => ({
  k: "tool", tool: "codex", source: "t", ts, sessionId, name: "Bash", category: "shell",
});

describe("sid", () => {
  test("prefixes tool", () => expect(sid("codex", "abc")).toBe("codex:abc"));
});

describe("EventStore", () => {
  test("add keeps insertion order", () => {
    const s = new EventStore();
    s.add(tool("s1", 1)); s.add(tool("s2", 2)); s.add(tool("s1", 3));
    expect(s.all("tool").map((e) => e.ts)).toEqual([1, 2, 3]);
    expect(s.all("prompt")).toEqual([]);
  });

  test("forSession filters and updates after add", () => {
    const s = new EventStore();
    s.add(tool("s1", 1)); s.add(tool("s2", 2)); s.add(tool("s1", 3));
    expect(s.forSession("s1", "tool").map((e) => e.ts)).toEqual([1, 3]);
    s.add(tool("s1", 4));
    expect(s.forSession("s1", "tool").map((e) => e.ts)).toEqual([1, 3, 4]);
    expect(s.forSession("nope", "tool")).toEqual([]);
  });

  test("events without sessionId never match forSession", () => {
    const s = new EventStore();
    s.add({ k: "marker", tool: "codex", source: "t", ts: 1, kind: "error" });
    expect(s.forSession("undefined", "marker")).toEqual([]);
  });

  test("sessions with same id merge", () => {
    const s = new EventStore();
    s.add(sess({ start: 10, end: 20, models: ["a"], version: undefined }));
    s.add(sess({ start: 5, end: 15, models: ["b", "a"], version: "1.2", projectKey: "p" }));
    s.add(sess({ version: "9", projectKey: "q" }));
    const m = s.session("x")!;
    expect(m.start).toBe(5);
    expect(m.end).toBe(20);
    expect(m.models).toEqual(["a", "b"]);
    expect(m.version).toBe("1.2");
    expect(m.projectKey).toBe("p");
    expect(s.all("session").length).toBe(1);
    expect(s.all("session")[0]).toBe(m);
  });

  const merged = (...xs: SessionEv[]): SessionEv => {
    const s = new EventStore();
    for (const x of xs) s.add(x);
    return s.session("x")!;
  };

  test("merged origin: a non-human origin wins, subagent > peer > scripted > scheduled > system > human, in either order", () => {
    const ranked: Origin[] = ["subagent", "peer", "scripted", "scheduled", "system", "human"];
    ranked.forEach((winner, i) => {
      for (const other of ranked.slice(i)) {
        expect(merged(sess({ origin: winner }), sess({ origin: other })).origin).toBe(winner);
        expect(merged(sess({ origin: other }), sess({ origin: winner })).origin).toBe(winner);
      }
    });
    expect(merged(sess({ origin: "human" }), sess({ origin: "scripted" }), sess({ origin: "peer" })).origin).toBe("peer");
  });

  test("merged models: the sorted union, whatever the arrival order", () => {
    const a = sess({ models: ["m2", "m1"] });
    const b = sess({ models: ["m3", "m1", "m0"] });
    expect(merged(a, b).models).toEqual(["m0", "m1", "m2", "m3"]);
    expect(merged(b, a).models).toEqual(["m0", "m1", "m2", "m3"]);
    expect(merged(sess({ models: [] }), sess({ models: ["z", "a"] })).models).toEqual(["a", "z"]);
  });

  test("merged window: detail when either side is detail", () => {
    const cases: [Window, Window, Window][] = [["detail", "lifetime", "detail"], ["lifetime", "detail", "detail"], ["lifetime", "lifetime", "lifetime"], ["detail", "detail", "detail"]];
    for (const [a, b, want] of cases) expect(merged(sess({ window: a }), sess({ window: b })).window).toBe(want);
  });

  test("a rollout driven by another agent and its index row merge to the same session in either order", () => {
    const rollout = sess({ source: "codex.rollouts", window: "detail", origin: "peer", start: 100, end: 200, models: ["m"], surface: "cli", inRepo: true, projectKey: "p" });
    const indexRow = sess({ source: "codex.threads", window: "lifetime", origin: "human", start: 50, end: 300, models: ["m"], surface: "cli", approval: "never", sandbox: "managed", version: "0.169.0" });
    const ab = merged(rollout, indexRow);
    const ba = merged(indexRow, rollout);
    expect(ab).toMatchObject({ origin: "peer", window: "detail", start: 50, end: 300, models: ["m"], surface: "cli", inRepo: true, projectKey: "p", approval: "never", sandbox: "managed", version: "0.169.0" });
    expect(ab.source).toBe("codex.rollouts"); // the detail-window reader's, whichever arrived first
    expect(ba).toEqual(ab);
  });

  const FIELDS = ["source", "version", "surface", "mode", "inRepo", "projectKey", "parentId", "approval", "effort", "sandbox", "agentType", "spawnDepth"] as const;
  const detailRow = sess({ source: "x.detail", window: "detail", version: "2.0.0", surface: "cli", mode: "agent", inRepo: true, projectKey: "pd", parentId: "codex:pd", approval: "never", effort: "high", sandbox: "read-only", agentType: "explorer", spawnDepth: 2 });
  const lifetimeRow = sess({ source: "a.lifetime", window: "lifetime", version: "1.0.0", surface: "vscode", mode: "chat", inRepo: false, projectKey: "pl", parentId: "codex:pl", approval: "on-request", effort: "low", sandbox: "workspace-write", agentType: "default", spawnDepth: 1 });

  test("the detail-window report decides every other field, in either order, though its source sorts later", () => {
    for (const m of [merged(detailRow, lifetimeRow), merged(lifetimeRow, detailRow)]) {
      for (const f of FIELDS) expect([f, m[f]]).toEqual([f, detailRow[f]]);
    }
  });

  test("a field the detail report lacks comes from the lifetime report", () => {
    const bare = sess({ source: "x.detail", window: "detail" });
    for (const m of [merged(bare, lifetimeRow), merged(lifetimeRow, bare)]) {
      for (const f of FIELDS.filter((x) => x !== "source")) expect([f, m[f]]).toEqual([f, lifetimeRow[f]]);
      expect(m.source).toBe("x.detail");
    }
  });

  test("two reports of one window: the source that sorts first decides; two of one source: the smaller value, whatever the order", () => {
    const a = sess({ source: "a.src", window: "lifetime", surface: "zeta", version: "2.0.0" });
    const b = sess({ source: "b.src", window: "lifetime", surface: "alpha", version: "1.0.0", effort: "max" });
    for (const m of [merged(a, b), merged(b, a)]) expect(m).toMatchObject({ source: "a.src", surface: "zeta", version: "2.0.0", effort: "max" });
    const c = sess({ source: "s", surface: "zeta", inRepo: true, spawnDepth: 3 });
    const d = sess({ source: "s", surface: "alpha", inRepo: false, spawnDepth: 1 });
    for (const m of [merged(c, d), merged(d, c)]) expect(m).toMatchObject({ surface: "alpha", inRepo: false, spawnDepth: 1 });
  });

  test("three reports merge to the same session in every arrival order", () => {
    const x = sess({ source: "c.rollouts", window: "detail", origin: "human", start: 20, end: 30, models: ["b"], surface: "cli" });
    const y = sess({ source: "c.threads", window: "lifetime", origin: "scripted", start: 10, end: 40, models: ["a"], approval: "never", surface: "exec" });
    const z = sess({ source: "c.other", window: "lifetime", origin: "human", start: 15, end: 25, models: [], version: "1.2.3", surface: "vscode" });
    const orders = [[x, y, z], [x, z, y], [y, x, z], [y, z, x], [z, x, y], [z, y, x]];
    const results = orders.map((o) => merged(...o));
    for (const m of results) expect(m).toEqual(results[0]!);
    expect(results[0]).toMatchObject({ source: "c.rollouts", window: "detail", origin: "scripted", start: 10, end: 40, models: ["a", "b"], surface: "cli", approval: "never", version: "1.2.3" });
  });

  /** Every arrival order of `xs`. */
  const orders = <T>(xs: readonly T[]): T[][] => (xs.length <= 1 ? [[...xs]] : xs.flatMap((x, i) => orders([...xs.slice(0, i), ...xs.slice(i + 1)]).map((o) => [x, ...o])));

  test("three reports, all 6 arrival orders: one session; a field the detail report lacks comes from the first source in rank order", () => {
    const r1 = sess({ window: "detail", source: "codex.rollouts", surface: "cli", version: "2.0.0", projectKey: "pd" });
    const r2 = sess({ window: "lifetime", source: "codex.threads", approval: "on-request", surface: "vscode", version: "1.0.0", projectKey: "p2" });
    const r3 = sess({ window: "lifetime", source: "codex.zz", approval: "never", surface: "exec", version: "0.1.0", projectKey: "p3" });
    const results = orders([r1, r2, r3]).map((o) => merged(...o));
    expect(results).toHaveLength(6);
    for (const m of results) expect(m).toEqual(results[0]!);
    expect(results[0]!.approval).toBe("on-request");
    expect(results[0]).toMatchObject({ source: "codex.rollouts", window: "detail", surface: "cli", version: "2.0.0", projectKey: "pd" });
  });

  test("mergeSessions gives the same session for any order of the reports", () => {
    const a = sess({ window: "detail", source: "s.b", origin: "human", start: 20, end: 30, models: ["m2"], surface: "cli" });
    const b = sess({ window: "lifetime", source: "s.a", origin: "peer", start: 10, end: 25, models: ["m1"], approval: "never", surface: "exec" });
    const c = sess({ window: "lifetime", source: "s.a", start: 15, end: 40, models: ["m2", "m0"], approval: "on-request", effort: "high" });
    const all = orders([a, b, c]).map((o) => mergeSessions(o));
    for (const m of all) expect(m).toEqual(all[0]!);
    expect(all[0]).toEqual({
      k: "session", tool: "codex", id: "x", source: "s.b", window: "detail", origin: "peer", start: 10, end: 40, models: ["m0", "m1", "m2"],
      surface: "cli", approval: "never", effort: "high",
    });
  });

  test("many reports of one session cost one merge: 20,000 reports, then a read, equal mergeSessions of them all", () => {
    const s = new EventStore();
    const reports = Array.from({ length: 20_000 }, (_, i) => sess({ id: "one", window: i % 2 ? "lifetime" : "detail", source: `s.${i % 7}`, start: 1_000 + (i * 37) % 5_000, end: 9_000 + i, models: [`m${i % 5}`] }));
    for (const r of reports) s.add(r);
    s.add(sess({ id: "two" }));
    expect(s.all("session")).toHaveLength(2);
    expect(s.session("one")).toEqual(mergeSessions(reports));
    expect(s.all("session")[0]).toEqual(mergeSessions(reports));
    // a report added after a read is merged on the next one
    const late = sess({ id: "one", window: "lifetime", source: "a.first", start: 1, end: 2, models: ["z"] });
    s.add(late);
    expect(s.session("one")).toEqual(mergeSessions([...reports, late]));
  });

  test("a merge replaces the session in place: the session list keeps one entry per id, in first-arrival order", () => {
    const s = new EventStore();
    s.add(sess({ id: "a" }));
    s.add(sess({ id: "b" }));
    s.add(sess({ id: "a", source: "z", window: "lifetime", version: "1" }));
    s.add(sess({ id: "c" }));
    s.add(sess({ id: "b", start: 1 }));
    expect(s.all("session").map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(s.all("session")[0]).toBe(s.session("a")!);
    expect(s.all("session")[1]!.start).toBe(1);
  });

  test("count only lists non-empty kinds", () => {
    const s = new EventStore();
    s.add(sess({})); s.add(sess({ start: 5, end: 15, models: ["b"] }));
    s.add(tool("x", 1)); s.add(tool("x", 2)); s.add(tool("y", 3));
    expect(s.count()).toEqual({ session: 1, tool: 3 });
  });
});

describe("forSession: the compact index", () => {
  test("for every kind and a spread of sessions, exactly the events a filter over all(kind) gives: same order, same objects", async () => {
    const { synthStore } = await import("../../kit/synth");
    const r = synthStore(30_000);
    const ids = r.store.all("session").map((s) => s.id).filter((_, i) => i % 7 === 0);
    ids.push("claude-code:no-such-session"); // unknown
    r.store.add({ k: "session", tool: "claude-code", source: "t", id: "claude-code:empty", window: "detail", origin: "human", start: 0, end: 1, models: [] });
    ids.push("claude-code:empty"); // a session with no events
    const kinds = Object.keys(r.store.count()) as Array<keyof ReturnType<EventStore["count"]>>;
    expect(kinds.length).toBeGreaterThan(5);
    let compared = 0;
    for (const k of kinds) {
      for (const id of ids) {
        const want = r.store.all(k).filter((e) => (e as { sessionId?: string }).sessionId === id);
        const got = r.store.forSession(id, k);
        expect(got.length).toBe(want.length);
        for (let i = 0; i < want.length; i++) expect(got[i]).toBe(want[i]!);
        compared += want.length;
      }
    }
    expect(compared).toBeGreaterThan(1_000);
    for (const k of kinds) {
      expect(r.store.forSession("claude-code:empty", k)).toEqual([]);
      expect(r.store.forSession("claude-code:no-such-session", k)).toEqual([]);
    }
  });

  test("a session first seen in a later kind, and an add after the index is built", () => {
    const s = new EventStore();
    s.add({ k: "marker", tool: "codex", source: "t", ts: 1, sessionId: "a", kind: "error" });
    s.add(tool("b", 2)); s.add(tool("a", 3)); s.add(tool("b", 4));
    expect(s.forSession("b", "tool").map((e) => e.ts)).toEqual([2, 4]);
    expect(s.forSession("a", "tool").map((e) => e.ts)).toEqual([3]);
    expect(s.forSession("b", "marker")).toEqual([]);
    const late = tool("a", 5);
    s.add(late);
    expect(s.forSession("a", "tool").at(-1)).toBe(late);
  });
});
