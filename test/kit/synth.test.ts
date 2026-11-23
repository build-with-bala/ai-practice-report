import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { synthStore } from "./synth";

const total = (c: Partial<Record<string, number>>): number => Object.values(c).reduce((a, b) => a! + b!, 0)!;

describe("synthStore", () => {
  test("holds exactly the events asked for", () => {
    for (const n of [0, 1, 3, 1_000, 12_345, 50_000]) expect([n, total(synthStore(n).store.count())]).toEqual([n, n]);
  });

  test("the same call gives an equal result", () => {
    const a = synthStore(20_000);
    const b = synthStore(20_000);
    expect(a.store.count()).toEqual(b.store.count());
    expect(b).toEqual(a);
  });

  test("calls no clock and no random source", () => {
    const now = Date.now;
    const random = Math.random;
    const perf = performance.now;
    const boom = () => { throw new Error("clock or random used"); };
    Date.now = boom;
    Math.random = boom;
    performance.now = boom;
    try {
      expect(total(synthStore(5_000).store.count())).toBe(5_000);
    } finally {
      Date.now = now;
      Math.random = random;
      performance.now = perf;
    }
    const src = readFileSync(path.join(import.meta.dir, "synth.ts"), "utf8");
    expect(src).not.toMatch(/Math\.random|Date\.now|new Date\(|performance\.now|randomBytes|getRandomValues|randomUUID/);
  });

  test("the mix: sessions with subagents, human prompts, tools, usage, anchors, markers, turns and repo signals", () => {
    const r = synthStore(100_000);
    const c = r.store.count();
    for (const k of ["session", "prompt", "tool", "usage", "anchor", "marker", "turn", "coverage"] as const) expect([k, (c[k] ?? 0) > 0]).toEqual([k, true]);
    const sessions = r.store.all("session");
    const top = sessions.filter((s) => s.parentId === undefined);
    const subs = sessions.filter((s) => s.parentId !== undefined);
    expect(top.length).toBeGreaterThan(0);
    expect(subs.length).toBeGreaterThan(0);
    for (const s of subs) {
      expect(s.origin).toBe("subagent");
      expect(r.store.session(s.parentId!)).toBeDefined();
    }
    // every delegating call names a subagent session of its own session (but, at most, the one the cut-off left childless)
    const delegations = r.store.all("tool").filter((t) => t.delegateTo !== undefined);
    const childless = delegations.filter((t) => r.store.session(t.delegateTo!) === undefined);
    expect(childless.length).toBeLessThanOrEqual(1);
    expect(subs.length).toBe(delegations.length - childless.length);
    for (const t of delegations) if (!childless.includes(t)) expect(r.store.session(t.delegateTo!)!.parentId).toBe(t.sessionId);

    const prompts = r.store.all("prompt");
    expect(prompts.some((p) => p.origin === "human" && p.window === "detail")).toBe(true);
    expect(prompts.some((p) => p.window === "lifetime")).toBe(true);
    const kinds = new Set(r.store.all("marker").map((m) => m.kind));
    for (const k of ["interrupt", "commit", "pr-link", "compact-auto", "clear"] as const) expect(kinds.has(k)).toBe(true);
    expect(new Set(r.store.all("anchor").map((a) => a.kind))).toEqual(new Set(["cc-msg", "cc-req"]));

    // Claude Code-like proportions: tool calls and model calls outnumber typed prompts several times over
    const human = prompts.filter((p) => p.origin === "human" && p.window === "detail").length;
    expect(c.tool! / human).toBeGreaterThan(3);
    expect(c.usage! / human).toBeGreaterThan(2);
    // two anchors per model call (the cut-off may fall between a call and its anchors)
    expect(2 * c.usage! - c.anchor!).toBeGreaterThanOrEqual(0);
    expect(2 * c.usage! - c.anchor!).toBeLessThanOrEqual(2);

    // every event of a session lies within it, and sessions name repos the repo signals know
    for (const k of ["tool", "usage", "turn"] as const) {
      for (const e of r.store.all(k)) {
        const s = r.store.session(e.sessionId)!;
        expect(e.ts >= s.start && e.ts <= s.end).toBe(true);
      }
    }
    expect(r.repos.status).toBe("ok");
    expect(r.repos.repos.length).toBeGreaterThan(0);
    const repoProjects = new Set(r.repos.repos.flatMap((x) => x.projectKeys));
    expect(top.every((s) => s.projectKey !== undefined && repoProjects.has(s.projectKey))).toBe(true);
    expect(r.repos.repos.reduce((n, x) => n + x.commits.length, 0)).toBeGreaterThan(0);
    const commitKeys = new Set(r.repos.repos.flatMap((x) => x.commits.map((cm) => cm.shaKey)));
    const commitMarkers = r.store.all("marker").filter((m) => m.kind === "commit");
    expect(commitMarkers.every((m) => commitKeys.has(m.detail!))).toBe(true);
  });

  test("ids, hashes and paths are plainly synthetic; finishedAt comes from the data", () => {
    const r = synthStore(10_000);
    for (const s of r.store.all("session")) expect(s.id).toMatch(/^claude-code:synth-/);
    for (const p of r.store.all("prompt")) expect(p.textHash).toMatch(/^synth-/);
    for (const a of r.store.all("anchor")) expect(a.idTail).toContain("Synth");
    for (const root of r.repos.roots.values()) expect(root).toMatch(/^\/synthetic\//);
    for (const cwd of r.cwds.values()) expect(cwd).toMatch(/^\/synthetic\//);
    let latest = 0;
    for (const s of r.store.all("session")) latest = Math.max(latest, s.end);
    expect(r.finishedAt).toBeGreaterThanOrEqual(latest);
    expect(r.startedAt).toBeLessThanOrEqual(r.finishedAt);
  });
});
