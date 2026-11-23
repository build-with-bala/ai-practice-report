import type { ReleaseTable } from "../../../core/forensics/releases";
import type { AnchorEv, ConfigEv, CoverageEv, Ev, PromptEv, RateLimitEv, SessionEv, ToolEv } from "../../../core/model/events";
import type { ToolId, Window } from "../../../core/model/ids";
import type { ScanResult } from "../../../core/scan";
import { scanResultOf } from "../../kit/scanresult";

/*
 * A synthetic world for the exclusion tests: two tools (Claude Code, Codex), two projects (`kA`, `kB`) and two periods
 * of ten days, twenty days apart, with every kind of event a forensic check reads. Each event is tagged with its tool,
 * its project when it is bound to a session of one, and its period when it is dated, so a test can build the same world
 * without a slice and compare.
 */

export const SEC = 1_000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const T0 = Date.UTC(2026, 8, 1, 8, 0);
/** The start of the second period; anything from `T0 + 15 days` on is the second period. */
export const LATE = T0 + 20 * DAY;
export const MID = T0 + 15 * DAY;
export const NOW = T0 + 31 * DAY;
export const TABLE: ReleaseTable = { version: 1, models: [{ match: "^model-w$", released: "2026-01-01", source: "https://example.com/w" }], tools: {} };

export type Project = "A" | "B";
export interface Tagged { ev: Ev; tool: ToolId; project?: Project; period?: 0 | 1 }

/** A seeded generator (mulberry32): the world is the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function enc(v: bigint, width: number): string {
  let s = "";
  for (let x = v; x > 0n; x /= 58n) s = B58[Number(x % 58n)]! + s;
  return s.padStart(width, "1");
}

const CC = "claude-code.transcripts";
const CX = "codex.rollouts";
const cov = (tool: ToolId, source: string, window: Window, over: Partial<CoverageEv> = {}): CoverageEv => ({
  k: "coverage", tool, source, window, status: "ok", beta: false, files: 1, bytes: 1, records: 10, skipped: {}, unknownTypes: {}, versions: [], ...over,
});
const features = { words: 5, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: false, techCats: {} } as const;
const config = (tool: ToolId, over: Partial<ConfigEv>): ConfigEv =>
  ({ k: "config", tool, source: `${tool}.config`, kind: "skill", name: "skill-a", provenance: "authored", firstSeen: NOW - 2 * DAY, ...over });

/** Every event of the world, tagged. */
export function world(): Tagged[] {
  const r = rng(7);
  const out: Tagged[] = [];
  const add = (ev: Ev, tool: ToolId, period?: 0 | 1, project?: Project): void => {
    const x: Tagged = { ev, tool };
    if (period !== undefined) x.period = period;
    if (project !== undefined) x.project = project;
    out.push(x);
  };

  // undated, sessionless: coverage, config entries, the config account
  add(cov("claude-code", CC, "detail"), "claude-code");
  add(cov("claude-code", "claude-code.history", "lifetime"), "claude-code");
  add(cov("codex", CX, "detail"), "codex");
  add(cov("codex", "codex.threads", "lifetime"), "codex");
  add(config("claude-code", { uses: 3 }), "claude-code");
  for (const p of ["A", "B"] as const) add(config("claude-code", { kind: "mcp-server", name: `docs-${p}`, uses: undefined }), "claude-code");
  add(config("claude-code", { name: "skill-b", uses: 2 }), "claude-code");
  add(config("codex", { name: "skill-c", uses: 1 }), "codex");
  add({ k: "identity", tool: "claude-code", source: "claude-code.config", scope: "config", hash: "acct-a" }, "claude-code");

  for (const period of [0, 1] as const) {
    const base = period === 0 ? T0 : LATE;
    // sessionless and dated: anchors, files, day totals, the usage-limit ledger
    for (const kind of ["cc-msg", "cc-req"] as const) {
      for (let i = 0; i < 100; i++) {
        const ts = base + i * 2 * HOUR + Math.floor(r() * MIN);
        const tail = `01${enc(3n * 58n ** 11n + BigInt(ts - T0) * 1_000n, 12)}${Array.from({ length: 10 }, () => B58[Math.floor(r() * 58)]!).join("")}`;
        const a: AnchorEv = { k: "anchor", tool: "claude-code", source: CC, kind, ts, idTail: tail };
        add(a, "claude-code", period);
      }
    }
    for (let i = 0; i < 6; i++) {
      const firstTs = base + i * DAY;
      add({ k: "file", tool: "claude-code", source: CC, pathHash: `f${period}-${i}`, bytes: 1, birth: firstTs, firstTs, lastTs: firstTs + HOUR,
        mtime: firstTs + HOUR + SEC, ctime: firstTs + HOUR + SEC }, "claude-code", period);
    }
    for (const d of [0, 2]) add({ k: "daily", tool: "claude-code", source: "claude-code.stats", day: new Date(base + d * DAY).toISOString().slice(0, 10),
      zone: "utc", unit: "messages", count: 10 }, "claude-code", period);
    for (let w = 0; w < 6; w++) {
      const resets = base + (w + 1) * 5 * HOUR;
      for (let i = 0; i < 8; i++) {
        const e: RateLimitEv = { k: "ratelimit", tool: "codex", source: CX, ts: base + w * 5 * HOUR + i * 30 * MIN + 7 * MIN, window: "primary",
          usedPercent: i * 5 + (period === 1 && w === 2 && i >= 4 ? -15 : 0) + (period === 1 && w === 2 && i >= 6 ? -15 : 0), resetsAt: resets };
        add(e, "codex", period);
      }
    }

    for (const project of ["A", "B"] as const) {
      // Claude Code: a session with typed prompts, their history echoes, tool calls and its account
      const id = `claude-code:${project}${period}`;
      const start = base + (project === "A" ? 0 : 2 * DAY);
      const s: SessionEv = { k: "session", tool: "claude-code", source: CC, id, window: "detail", origin: "human", start, end: start + DAY,
        models: ["model-w"], projectKey: `k${project}` };
      add(s, "claude-code", period, project);
      let ts = start;
      for (let i = 0; i < 60; i++) {
        ts += Math.floor((0.5 + r() * 24) * MIN);
        const long = i < 6;
        const p: PromptEv = { k: "prompt", tool: "claude-code", source: CC, ts, sessionId: id, window: "detail", origin: i % 10 === 9 ? "scripted" : "human",
          intent: "spec", textHash: long ? `long-${project}${period}` : `cc-${project}${period}-${i}`, features: { ...features, ...(i < 30 ? { chars: long ? 300 : 40 } : {}) } };
        add(p, "claude-code", period, project);
        if (i < 40 && p.origin === "human") {
          const h: PromptEv = { k: "prompt", tool: "claude-code", source: "claude-code.history", ts: ts + 5 * SEC, window: "lifetime", origin: "human",
            intent: "spec", textHash: p.textHash, features };
          if (i % 2 === 0) {
            h.sessionId = id;
            add(h, "claude-code", period, project);
          } else add(h, "claude-code", period);
        }
      }
      for (let i = 0; i < 30; i++) {
        const t: ToolEv = { k: "tool", tool: "claude-code", source: CC, ts: start + i * 10 * MIN, sessionId: id, name: "Read", category: "read",
          ...(i % (project === "A" ? 3 : 2) === 0 ? {} : { ok: true }) };
        if (i === 0) Object.assign(t, { name: `mcp__docs-${project}__q`, category: "mcp", mcpServer: `docs-${project}` });
        add(t, "claude-code", period, project);
      }
      add({ k: "identity", tool: "claude-code", source: CC, scope: "session", hash: `acct-${project === "A" ? "a" : "b"}`, sessionId: id }, "claude-code", period, project);

      // Codex: a session with prompts and tool calls, its rollout and its thread row
      const cid = `codex:${project}${period}`;
      const cstart = base + (project === "A" ? DAY : 3 * DAY);
      add({ k: "session", tool: "codex", source: CX, id: cid, window: "detail", origin: "human", start: cstart, end: cstart + 2 * HOUR, models: ["model-w"],
        projectKey: `k${project}` }, "codex", period, project);
      for (let i = 0; i < 5; i++) {
        add({ k: "prompt", tool: "codex", source: CX, ts: cstart + i * 10 * MIN, sessionId: cid, window: "detail", origin: "human", intent: "spec",
          textHash: `cx-${project}${period}-${i}`, features }, "codex", period, project);
      }
      add({ k: "codex-rollout", tool: "codex", source: CX, threadId: cid, fileTs: cstart, uuidTs: cstart + 400 }, "codex", period, project);
      add({ k: "codex-thread-row", tool: "codex", source: "codex.threads", threadId: cid, createdAt: cstart + 300 }, "codex", period);
    }
    // a session of project B whose rollout has no thread row
    if (period === 1) {
      const xid = "codex:B1-unindexed", xstart = base + 4 * DAY;
      add({ k: "session", tool: "codex", source: CX, id: xid, window: "detail", origin: "human", start: xstart, end: xstart + HOUR, models: [],
        projectKey: "kB" }, "codex", period, "B");
      add({ k: "codex-rollout", tool: "codex", source: CX, threadId: xid, fileTs: xstart, uuidTs: xstart + 400 }, "codex", period, "B");
    }
  }
  return out;
}

/** The scan of some tagged events, finished at `NOW`. */
export const scanOf = (xs: readonly Tagged[]): ScanResult => scanResultOf(xs.map((x) => x.ev), { finishedAt: NOW });
