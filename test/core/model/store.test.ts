import { describe, expect, test } from "bun:test";
import type { SessionEv, ToolEv } from "../../../core/model/events";
import { sid, type Origin, type Window } from "../../../core/model/ids";
import { EventStore } from "../../../core/model/store";

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
    // every other field keeps the first defined value: here only `source` (the reader that arrived first) differs
    expect([ab.source, ba.source]).toEqual(["codex.rollouts", "codex.threads"]);
    expect({ ...ba, source: ab.source }).toEqual(ab);
  });

  test("count only lists non-empty kinds", () => {
    const s = new EventStore();
    s.add(sess({})); s.add(sess({ start: 5, end: 15, models: ["b"] }));
    s.add(tool("x", 1)); s.add(tool("x", 2)); s.add(tool("y", 3));
    expect(s.count()).toEqual({ session: 1, tool: 3 });
  });
});
