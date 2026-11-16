import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectEnv } from "../../core/env/env";
import type { CoverageEv, Ev } from "../../core/model/events";
import type { ToolId } from "../../core/model/ids";
import { scan } from "../../core/scan";
import type { Candidate, ScanCtx, SourcePlugin } from "../../core/sources/types";

const home = mkdtempSync(path.join(os.tmpdir(), "scan-test-"));
const env = detectEnv({ home, tmp: os.tmpdir(), platform: "linux", wslHomes: [] });

function cov(tool: ToolId, source: string, over: Partial<CoverageEv> = {}): CoverageEv {
  return { k: "coverage", tool, source, window: "detail", status: "ok", beta: false, files: 1, bytes: 1, records: 1, skipped: {}, unknownTypes: {}, versions: [], ...over };
}
function plugin(tool: ToolId, id: string, run: (ctx: ScanCtx) => Promise<void> | void, beta = false, n = 1): SourcePlugin {
  return {
    tool, id, tier: "P0", beta, describe: { reads: [], neverReads: [] },
    locate: () => Array.from({ length: n }, (): Candidate => ({ root: home, home, wsl: false })),
    scan: async (_c, ctx) => { await run(ctx); },
  };
}
const session = (tool: ToolId, source: string): Ev => ({ k: "session", tool, source, id: `${tool}:s`, window: "detail", origin: "human", start: 1, end: 2, models: [] });
const toolEv = (tool: ToolId, source: string, i: number): Ev => ({ k: "tool", tool, source, ts: i, sessionId: `${tool}:s`, name: "Read", category: "read" });

describe("scan", () => {
  test("collects events from a plugin", async () => {
    const p = plugin("codex", "codex-a", (c) => { c.emit(session("codex", "codex-a")); c.emit(toolEv("codex", "codex-a", 1)); c.emit(toolEv("codex", "codex-a", 2)); c.emit(cov("codex", "codex-a")); });
    const r = await scan({ env, plugins: [p] });
    expect(r.store.count()).toEqual({ session: 1, tool: 2, coverage: 1 });
    expect(r.coverage).toHaveLength(1);
  });

  test("throwing plugin yields error coverage + warning; others continue", async () => {
    const bad = plugin("codex", "bad", () => { throw new TypeError("secret /path"); });
    const good = plugin("cursor", "good", (c) => { c.emit(session("cursor", "good")); c.emit(cov("cursor", "good")); });
    const r = await scan({ env, plugins: [bad, good], concurrency: 1 });
    expect(r.coverage[0]!.status).toBe("error");
    expect(r.coverage[0]!.note).toBe("TypeError");
    expect(r.warnings.find((w) => w.code === "error")!.detail).toBe("TypeError");
    expect(JSON.stringify(r.warnings)).not.toContain("secret");
    expect(r.store.all("session")).toHaveLength(1);
  });

  test("drift coverage and unknownTypes warn", async () => {
    const a = plugin("codex", "a", (c) => c.emit(cov("codex", "a", { status: "drift", unknownTypes: { x: 2, y: 1 } })));
    const b = plugin("cursor", "b", (c) => c.emit(cov("cursor", "b", { unknownTypes: { z: 4 } })));
    const r = await scan({ env, plugins: [a, b] });
    const d = r.warnings.filter((w) => w.code === "drift");
    expect(d).toHaveLength(2);
    expect(d.find((w) => w.source === "a")!.detail).toBe("3 unknown types");
  });

  test("too-large and beta warnings", async () => {
    const a = plugin("codex", "a", (c) => c.emit(cov("codex", "a", { note: "too-large" })));
    const b = plugin("cursor", "b", (c) => { c.emit(session("cursor", "b")); c.emit(cov("cursor", "b", { beta: true })); }, true);
    const r = await scan({ env, plugins: [a, b] });
    expect(r.warnings.some((w) => w.code === "too-large" && w.source === "a")).toBe(true);
    expect(r.warnings.some((w) => w.code === "beta" && w.source === "b")).toBe(true);
  });

  test("zero candidates adds an absent coverage", async () => {
    const p = plugin("codex", "none", () => {}, true, 0);
    const r = await scan({ env, plugins: [p] });
    expect(r.coverage).toHaveLength(1);
    expect(r.coverage[0]).toMatchObject({ status: "absent", beta: true, files: 0, window: "detail", source: "none" });
  });

  test("registerCwd keys and first-seen raw path", async () => {
    const keys: string[] = [];
    const p = plugin("codex", "a", (c) => { keys.push(c.registerCwd("/a/b/"), c.registerCwd("/a/b"), c.registerCwd("/a/c"), c.hash("x")); });
    const r = await scan({ env, plugins: [p] });
    expect(keys[0]).toBe(keys[1]!);
    expect(keys[2]).not.toBe(keys[0]!);
    expect(r.cwds.get(keys[0]!)).toBe("/a/b/");
  });

  test("temp dirs are removed", async () => {
    let dir = "";
    const p = plugin("codex", "a", (c) => { dir = c.temp.dir(); writeFileSync(path.join(dir, "f"), "x"); });
    const r = await scan({ env, plugins: [p] });
    expect(r.tempClean).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  test("tools filter", async () => {
    const ran: string[] = [];
    const a = plugin("codex", "a", () => { ran.push("a"); });
    const b = plugin("cursor", "b", () => { ran.push("b"); });
    await scan({ env, plugins: [a, b], tools: ["codex"] });
    expect(ran).toEqual(["a"]);
  });

  test("abort stops scheduling; progress reported", async () => {
    const ac = new AbortController();
    const ran: number[] = [];
    const p = plugin("codex", "a", () => { ran.push(1); ac.abort(); }, false, 5);
    const prog: number[] = [];
    await scan({ env, plugins: [p], concurrency: 1, signal: ac.signal, onProgress: (x) => prog.push(x.done) });
    expect(ran).toHaveLength(1);
    expect(prog).toEqual([1]);
  });
});

process.on("exit", () => rmSync(home, { recursive: true, force: true }));
