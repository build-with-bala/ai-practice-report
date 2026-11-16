import { describe, expect, test } from "bun:test";
import type { SessionEv, ToolEv } from "../../../core/model/events";
import { sid } from "../../../core/model/ids";
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

  test("count only lists non-empty kinds", () => {
    const s = new EventStore();
    s.add(sess({})); s.add(sess({ start: 5, end: 15, models: ["b"] }));
    s.add(tool("x", 1)); s.add(tool("x", 2)); s.add(tool("y", 3));
    expect(s.count()).toEqual({ session: 1, tool: 3 });
  });
});
