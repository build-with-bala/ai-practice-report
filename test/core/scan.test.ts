import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectEnv } from "../../core/env/env";
import { readJsonlStream } from "../../core/io/jsonl";
import { TERM_SIGNALS } from "../../core/io/signals";
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

describe("scan hygiene", () => {
  test("throwing onProgress/onLog does not fail the scan", async () => {
    const a = plugin("codex", "a", (c) => { c.log("info", "x"); c.emit(session("codex", "a")); });
    const b = plugin("cursor", "b", (c) => { c.emit(session("cursor", "b")); });
    const r = await scan({ env, plugins: [a, b], onProgress: () => { throw new Error("ui"); }, onLog: () => { throw new Error("ui"); } });
    expect(r.store.all("session")).toHaveLength(2);
    expect(r.tempClean).toBe(true);
  });

  test("throwing plugin that made a temp dir leaves nothing; base removed", async () => {
    let dir = "";
    let base = "";
    const p = plugin("codex", "a", (c) => { dir = c.temp.dir(); base = path.dirname(dir); throw new RangeError("x"); });
    const r = await scan({ env, plugins: [p] });
    expect(r.tempClean).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(base)).toBe(false);
  });

  test("locate() throwing yields error coverage", async () => {
    const p = plugin("codex", "a", () => {});
    p.locate = () => { throw new SyntaxError("x"); };
    const r = await scan({ env, plugins: [p] });
    expect(r.coverage[0]).toMatchObject({ status: "error", note: "SyntaxError" });
  });

  test("failed disposeAll -> tempClean false + cleanup-failed warning", async () => {
    const p = plugin("codex", "a", (c) => { c.temp.dir(); });
    const r = await scan({ env, plugins: [p], tempFactory: () => ({ dir: () => "", active: 0, disposeAll: () => { throw new Error("EPERM /secret"); } }) });
    expect(r.tempClean).toBe(false);
    const w = r.warnings.find((x) => x.code === "temp-leftover")!;
    expect(w).toMatchObject({ tool: "scan", detail: "cleanup-failed" });
    expect(JSON.stringify(r.warnings)).not.toContain("secret");
  });

  test("abort after first job marks unrun plugins aborted", async () => {
    const ac = new AbortController();
    const a = plugin("codex", "a", () => { ac.abort(); });
    const b = plugin("cursor", "b", () => {});
    const c = plugin("copilot", "c", () => {});
    const r = await scan({ env, plugins: [a, b, c], concurrency: 1, signal: ac.signal });
    const abortedCov = r.coverage.filter((x) => x.note === "aborted");
    expect(abortedCov.map((x) => x.source).sort()).toEqual(["b", "c"]);
    expect(abortedCov[0]).toMatchObject({ status: "error", files: 0, window: "detail" });
    expect(r.warnings.filter((w) => w.tool === "scan" && w.detail === "aborted")).toHaveLength(1);
  });

  test("already-aborted signal skips locate and marks all plugins", async () => {
    const ac = new AbortController();
    ac.abort();
    let located = false;
    const p = plugin("codex", "a", () => {});
    p.locate = () => { located = true; return []; };
    const r = await scan({ env, plugins: [p], signal: ac.signal });
    expect(located).toBe(false);
    expect(r.coverage[0]).toMatchObject({ status: "error", note: "aborted", source: "a" });
    expect(r.warnings.some((w) => w.tool === "scan")).toBe(true);
  });
});

describe("scan temp folder and concurrency", () => {
  test("a scan that makes no private copy never touches the temp folder: a missing one does not fail it", async () => {
    const missing = detectEnv({ home, tmp: path.join(home, "no-such-tmp"), platform: "linux", wslHomes: [] });
    const p = plugin("codex", "a", (c) => { c.emit(session("codex", "a")); c.emit(cov("codex", "a")); });
    const r = await scan({ env: missing, plugins: [p] });
    expect(r.tempClean).toBe(true);
    expect(r.store.all("session")).toHaveLength(1);
    expect(existsSync(path.join(home, "no-such-tmp"))).toBe(false);
  });

  test("the aipr-scan-* folder exists only while a private copy needs it, and is gone after the scan", async () => {
    const tmp = mkdtempSync(path.join(home, "tmp-"));
    const seen: string[][] = [];
    const quiet = plugin("codex", "quiet", () => { seen.push(readdirSync(tmp)); });
    const copier = plugin("cursor", "copier", (c) => { c.temp.dir(); seen.push(readdirSync(tmp)); });
    const r = await scan({ env: detectEnv({ home, tmp, platform: "linux", wslHomes: [] }), plugins: [quiet, copier], concurrency: 1 });
    expect(seen[0]).toEqual([]);
    expect(seen[1]!.map((n) => n.startsWith("aipr-scan-"))).toEqual([true]);
    expect(readdirSync(tmp)).toEqual([]);
    expect(r.tempClean).toBe(true);
  });

  test("a concurrency that is not a positive integer means the default: every plugin runs, none is aborted", async () => {
    for (const concurrency of [Number.NaN, 0, -2, 2.5, Number.POSITIVE_INFINITY]) {
      const ran: string[] = [];
      const ps = ["a", "b", "c", "d", "e"].map((id) => plugin("codex", id, () => { ran.push(id); }));
      const r = await scan({ env, plugins: ps, concurrency });
      expect([concurrency, ran.sort()]).toEqual([concurrency, ["a", "b", "c", "d", "e"]]);
      expect(r.coverage.filter((c) => c.note === "aborted")).toEqual([]);
    }
  });
});

describe("aborting a running scan", () => {
  const enc = new TextEncoder();
  const LINES = enc.encode(`${JSON.stringify({ type: "x", v: 1 })}\n`.repeat(512));
  /** A plugin that reads an endless JSONL stream until the scan is aborted, then emits its coverage as readers do. */
  const reader = (id: string): SourcePlugin => plugin("codex", id, async (c) => {
    let records = 0;
    for await (const _ of readJsonlStream(new ReadableStream<Uint8Array>({ pull: (ctl) => ctl.enqueue(LINES) }), { signal: c.signal })) {
      records++;
      if (records === 1) c.emit(session("codex", id));
    }
    c.emit(cov("codex", id, { records }));
  });

  test("an abort mid-read resolves promptly; the coverage of the source read in part is error/aborted, its counts kept", async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 80);
    const after = plugin("cursor", "after", () => {});
    const t0 = performance.now();
    const r = await scan({ env, plugins: [reader("endless"), after], concurrency: 1, signal: ac.signal });
    clearTimeout(timer);
    expect(performance.now() - t0).toBeLessThan(2_000);
    const own = r.coverage.find((c) => c.source === "endless")!;
    expect(own).toMatchObject({ status: "error", note: "aborted", files: 1 });
    expect(own.records).toBeGreaterThan(0);
    expect(r.store.all("session")).toHaveLength(1); // what was read before the abort stays
    expect(r.coverage.find((c) => c.source === "after")).toMatchObject({ status: "error", note: "aborted", records: 0 });
    expect(r.tempClean).toBe(true);
  });

  test("a coverage written before the abort stays as it was", async () => {
    const ac = new AbortController();
    const first = plugin("codex", "first", (c) => { c.emit(cov("codex", "first")); ac.abort(); });
    const r = await scan({ env, plugins: [first], signal: ac.signal });
    expect(r.coverage.find((c) => c.source === "first")).toMatchObject({ status: "ok" });
  });

  test("a plugin that throws once the scan is aborted gets error coverage noted aborted", async () => {
    const ac = new AbortController();
    const p = plugin("codex", "a", () => { ac.abort(); throw new DOMException("stop", "AbortError"); });
    const r = await scan({ env, plugins: [p], signal: ac.signal });
    expect(r.coverage[0]).toMatchObject({ status: "error", note: "aborted" });
  });
});

describe("signal policy", () => {
  const counts = () => TERM_SIGNALS.map((s) => process.listenerCount(s));

  test("SIGINT and SIGTERM are trapped while scan() runs, and only then", async () => {
    const before = counts();
    let during: number[] = [];
    await scan({ env, plugins: [plugin("codex", "a", () => { during = counts(); })] });
    expect(during).toEqual(before.map((n) => n + 1));
    expect(counts()).toEqual(before);
  });

  test("handleSignals false installs no handler: the application owns the signals", async () => {
    const before = counts();
    let during: number[] = [];
    await scan({ env, handleSignals: false, plugins: [plugin("codex", "a", () => { during = counts(); })] });
    expect(during).toEqual(before);
  });
});

describe("coverage the orchestrator writes", () => {
  const lifetime = (id: string, run: (ctx: ScanCtx) => Promise<void> | void, n = 1): SourcePlugin => ({ ...plugin("codex", id, run, false, n), window: "lifetime" });

  test("absent and error coverage take the plugin's window", async () => {
    const absent = lifetime("absent", () => {}, 0);
    const failing = lifetime("failing", () => { throw new TypeError("x"); });
    const unlocatable = lifetime("unlocatable", () => {});
    unlocatable.locate = () => { throw new SyntaxError("x"); };
    const r = await scan({ env, plugins: [absent, failing, unlocatable] });
    expect(r.coverage.map((c) => [c.source, c.status, c.window]).sort()).toEqual([
      ["absent", "absent", "lifetime"], ["failing", "error", "lifetime"], ["unlocatable", "error", "lifetime"],
    ]);
  });

  test("aborted coverage takes the plugin's window; a plugin without one gets detail", async () => {
    const ac = new AbortController();
    const first = plugin("codex", "first", () => { ac.abort(); });
    const later = lifetime("later", () => {});
    const plain = plugin("cursor", "plain", () => {});
    const r = await scan({ env, plugins: [first, later, plain], concurrency: 1, signal: ac.signal });
    expect(r.coverage.filter((c) => c.note === "aborted").map((c) => [c.source, c.window]).sort()).toEqual([["later", "lifetime"], ["plain", "detail"]]);
  });
});

process.on("exit", () => rmSync(home, { recursive: true, force: true }));
