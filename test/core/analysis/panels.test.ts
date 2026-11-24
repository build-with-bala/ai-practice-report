import { describe, expect, test } from "bun:test";
import { projectLabels, projects } from "../../../core/analysis/labels";
import { panels } from "../../../core/analysis/panels";
import { buildSessionTable } from "../../../core/analysis/sessions";
import type { Exclusions } from "../../../core/analysis/types";
import type { ConfigEv, CoverageEv, Ev, MarkerEv, PromptEv, PromptFeatures, SessionEv, ToolEv } from "../../../core/model/events";
import type { MarkerKind, ToolId, Window } from "../../../core/model/ids";
import { keyedHash } from "../../../core/text/hash";
import { scanResultOf } from "../../kit/scanresult";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 2); // Monday, 00:00 UTC
const CC = "claude-code.transcripts";
const HIST = "claude-code.history";
const CX = "codex.rollouts";
const CONF = "claude-code.config";
const SALT = new Uint8Array(32).fill(7);

const cov = (tool: ToolId, source: string, window: Window, over: Partial<CoverageEv> = {}): CoverageEv => ({
  k: "coverage", tool, source, window, status: "ok", beta: false, files: 1, bytes: 1, records: 1, skipped: {}, unknownTypes: {}, versions: [], ...over,
});
const COVERAGE: Ev[] = [cov("claude-code", CC, "detail"), cov("claude-code", HIST, "lifetime"), cov("claude-code", CONF, "lifetime"), cov("codex", CX, "detail")];
const SRC: Record<string, string> = { "claude-code:detail": CC, "claude-code:lifetime": HIST, "codex:detail": CX };
const sess = (id: string, start: number, over: Partial<SessionEv> = {}): SessionEv => {
  const tool = over.tool ?? "claude-code";
  const window = over.window ?? "detail";
  return { k: "session", tool, source: SRC[`${tool}:${window}`]!, id, window, origin: "human", start, end: start + HOUR, models: [], ...over };
};
const features = (over: Partial<PromptFeatures> = {}): PromptFeatures =>
  ({ words: 6, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: false, techCats: {}, ...over });
let hashes = 0;
const prompt = (sessionId: string | undefined, ts: number, over: Partial<PromptEv> = {}): PromptEv => {
  const tool = over.tool ?? "claude-code";
  const window = over.window ?? "detail";
  const p: PromptEv = { k: "prompt", tool, source: SRC[`${tool}:${window}`]!, ts, window, origin: "human", intent: "spec", textHash: `h${++hashes}`,
    features: features(), ...over };
  if (sessionId !== undefined) p.sessionId = sessionId;
  return p;
};
const tool = (sessionId: string, ts: number, over: Partial<ToolEv> = {}): ToolEv => {
  const t = over.tool ?? "claude-code";
  return { k: "tool", tool: t, source: t === "codex" ? CX : CC, ts, sessionId, name: "Read", category: "read", ...over };
};
const edit = (sessionId: string, ts: number, ext: string): ToolEv => tool(sessionId, ts, { name: "Edit", category: "edit", editExt: ext });
const marker = (sessionId: string, ts: number, kind: MarkerKind, over: Partial<MarkerEv> = {}): MarkerEv =>
  ({ k: "marker", tool: "claude-code", source: CC, ts, sessionId, kind, ...over });
const config = (kind: ConfigEv["kind"], name: string, over: Partial<ConfigEv> = {}): ConfigEv =>
  ({ k: "config", tool: "claude-code", source: CONF, kind, name, provenance: "authored", ...over });

function run(evs: Ev[], o: { exclude?: Exclusions; timeZone?: string; coverage?: Ev[] } = {}) {
  const raw = scanResultOf([...(o.coverage ?? COVERAGE), ...evs], { salt: SALT });
  const timeZone = o.timeZone ?? "UTC";
  const t = buildSessionTable(raw, { timeZone, ...(o.exclude ? { exclude: o.exclude } : {}) });
  return { t, raw, p: panels(t, raw, { timeZone }) };
}

describe("panels: stack", () => {
  test("languages, toolchains, tech categories and role edits", () => {
    const { p } = run([
      sess("a", T0, { end: T0 + 2 * HOUR }), prompt("a", T0, { features: features({ techCats: { ai: 2 } }) }), prompt("a", T0 + MIN, { features: features({ techCats: { ai: 1, data: 1 } }) }),
      edit("a", T0 + 1 * SEC, "kt"), edit("a", T0 + 2 * SEC, "ipynb"), edit("a", T0 + 3 * SEC, "tsx"), edit("a", T0 + 4 * SEC, "ts"),
      edit("a", T0 + 5 * SEC, "sql"), edit("a", T0 + 6 * SEC, "md"), edit("a", T0 + 7 * SEC, "sh"),
      tool("a", T0 + 8 * SEC, { name: "Write", category: "write", editExt: "GO" }),
      tool("a", T0 + 9 * SEC, { name: "Edit", category: "edit", editExt: "py", outcome: "denied" }), // no action
      tool("a", T0 + 10 * SEC, { name: "Bash", category: "test", checks: ["test"], ok: true, toolchain: "js" }),
      tool("a", T0 + 11 * SEC, { name: "Bash", category: "lint", checks: ["lint"], ok: false, toolchain: "js" }),
      tool("a", T0 + 12 * SEC, { name: "Bash", category: "build", checks: ["build"], toolchain: "go" }),
      // a lifetime prompt: claude-code has more detail prompts, so the tech categories read the detail window
      prompt(undefined, T0, { window: "lifetime", features: features({ techCats: { security: 9 } }) }),
    ]);
    expect(p.stack.languages).toEqual({ jvm: 1, py: 1, js: 2, any: 1, doc: 1, shell: 1, go: 1 });
    expect(p.stack.roleEdits).toEqual({ mobile: 1, data: 2, frontend: 1, backend: 2 });
    expect(p.stack.toolchains).toEqual({ js: 2, go: 1 });
    expect(p.stack.techCategories).toEqual({ ai: 3, data: 1 });
    expect(p.stack.meta).toMatchObject({ window: "detail", sources: [CC], n: 8, from: T0 + SEC, to: T0 + 8 * SEC });
  });

  test("an edit outside the date range or of an excluded tool counts nowhere", () => {
    const { p } = run([
      sess("a", T0, { end: T0 + 2 * HOUR }), prompt("a", T0 + HOUR), edit("a", T0 + MIN, "go"), edit("a", T0 + HOUR + MIN, "go"),
      sess("c", T0, { tool: "codex" }), prompt("c", T0 + HOUR, { tool: "codex" }), tool("c", T0 + HOUR + MIN, { tool: "codex", name: "apply_patch", category: "edit", editExt: "go" }),
    ], { exclude: { from: T0 + HOUR, tools: ["codex"] } });
    expect(p.stack.languages).toEqual({ go: 1 });
  });
});

describe("panels: risk", () => {
  test("permission counts sessions per mode; approval and sandbox count rows per value", () => {
    const { p } = run([
      sess("a", T0), prompt("a", T0), marker("a", T0 + MIN, "permission-mode", { detail: "default" }), marker("a", T0 + 2 * MIN, "permission-mode", { detail: "plan" }),
      sess("b", T0 + DAY), prompt("b", T0 + DAY), marker("b", T0 + DAY + MIN, "permission-mode", { detail: "default" }),
      marker("b", T0 + DAY + 2 * MIN, "permission-mode", { detail: "default" }),
      sess("c", T0, { tool: "codex", approval: "on-request", sandbox: "workspace-write" }), prompt("c", T0, { tool: "codex" }),
      sess("d", T0 + DAY, { tool: "codex", approval: "never", sandbox: "workspace-write" }), prompt("d", T0 + DAY, { tool: "codex" }),
    ]);
    expect(p.risk.permission).toEqual({ default: 2, plan: 1 });
    expect(p.risk.approval).toEqual({ "on-request": 1, never: 1 });
    expect(p.risk.sandbox).toEqual({ "workspace-write": 2 });
    expect(p.risk.meta).toMatchObject({ window: "detail", sources: [CX, CC].sort(), n: 4 });
  });
});

describe("panels: config", () => {
  test("byKind counts distinct entries by provenance and use; hooks disabled and memory files", () => {
    const { p } = run([
      sess("a", T0), prompt("a", T0), tool("a", T0 + MIN, { name: "mcp", category: "mcp", mcpServer: "srv" }),
      config("skill", "s1", { uses: 2 }), config("skill", "s2", { provenance: "installed" }), config("skill", "s3", { provenance: "bundled", uses: 1 }),
      config("skill", "s1", { source: "claude-code.plugins", provenance: "installed", uses: 0 }), // the same skill: one entry
      config("mcp-server", "srv", { provenance: "installed" }), config("mcp-server", "idle", { provenance: "unknown" }),
      config("feature", "hooks-disabled", { provenance: "unknown" }), config("memory-file", "m1"), config("memory-file", "m2"),
    ]);
    expect(p.config).toEqual({
      byKind: { skill: { authored: 1, installed: 1, other: 1, used: 2 }, "mcp-server": { authored: 0, installed: 1, other: 1, used: 1 } },
      hooksDisabled: true, memoryFiles: 2,
    });
    expect(p.privateConfig).toEqual([
      { kind: "mcp-server", name: "idle", key: keyedHash(SALT, "idle"), provenance: "unknown", used: false },
      { kind: "mcp-server", name: "srv", key: keyedHash(SALT, "srv"), provenance: "installed", used: true },
      { kind: "skill", name: "s1", key: keyedHash(SALT, "s1"), provenance: "authored", used: true },
      { kind: "skill", name: "s2", key: keyedHash(SALT, "s2"), provenance: "installed", used: false },
      { kind: "skill", name: "s3", key: keyedHash(SALT, "s3"), provenance: "bundled", used: true },
    ]);
  });

  test("no hooks-disabled feature: hooksDisabled false", () => {
    expect(run([config("hook", "PreToolUse")]).p.config).toEqual({ byKind: {}, hooksDisabled: false, memoryFiles: 0 });
  });
});

describe("panels: coverage", () => {
  test("rows per tool and window; a source with drift makes formatChanged", () => {
    const coverage: Ev[] = [
      cov("claude-code", CC, "detail", { from: T0 - DAY, to: T0 + DAY }), cov("claude-code", "claude-code.other", "detail", { status: "drift", from: T0 - 2 * DAY }),
      cov("claude-code", HIST, "lifetime", { beta: true }), cov("codex", CX, "detail", { status: "absent" }),
    ];
    const { p } = run([sess("a", T0), prompt("a", T0), prompt("a", T0 + MIN), sess("k", T0, { parentId: "a", origin: "subagent" }), prompt(undefined, T0, { window: "lifetime" })], { coverage });
    expect(p.coverage.rows).toEqual([
      { tool: "claude-code", window: "detail", sources: [{ source: "claude-code.other", status: "drift", beta: false }, { source: CC, status: "ok", beta: false }],
        from: T0 - 2 * DAY, to: T0 + DAY, sessions: 1, prompts: 2, formatChanged: true },
      { tool: "claude-code", window: "lifetime", sources: [{ source: HIST, status: "ok", beta: true }], sessions: 0, prompts: 1, formatChanged: false },
      { tool: "codex", window: "detail", sources: [{ source: CX, status: "absent", beta: false }], sessions: 0, prompts: 0, formatChanged: false },
    ]);
  });
});

describe("panels: coverage spans obey the date range", () => {
  const coverage: Ev[] = [
    cov("claude-code", CC, "detail", { from: T0 - 10 * DAY, to: T0 + 10 * DAY }),
    cov("claude-code", HIST, "lifetime", { from: T0 - 30 * DAY, to: T0 - 20 * DAY }), // wholly before the range
    cov("codex", CX, "detail", { from: T0 + 2 * DAY }), // open-ended, starts inside the range
  ];
  const evs: Ev[] = [sess("a", T0), prompt("a", T0)];
  const span = (r: { from?: number; to?: number }) => ({ from: r.from, to: r.to });

  test("each span is clipped to the range; a span wholly outside it has none", () => {
    const { p } = run(evs, { coverage, exclude: { from: T0 - DAY, to: T0 + 5 * DAY } });
    expect(p.coverage.rows.map(span)).toEqual([
      { from: T0 - DAY, to: T0 + 5 * DAY }, { from: undefined, to: undefined }, { from: T0 + 2 * DAY, to: undefined }, // an unknown end stays unknown
    ]);
  });

  test("an open range clips one end only; no range leaves the spans as reported", () => {
    expect(run(evs, { coverage, exclude: { from: T0 - DAY } }).p.coverage.rows.map(span)).toEqual([
      { from: T0 - DAY, to: T0 + 10 * DAY }, { from: undefined, to: undefined }, { from: T0 + 2 * DAY, to: undefined },
    ]);
    expect(run(evs, { coverage }).p.coverage.rows.map(span)).toEqual([
      { from: T0 - 10 * DAY, to: T0 + 10 * DAY }, { from: T0 - 30 * DAY, to: T0 - 20 * DAY }, { from: T0 + 2 * DAY, to: undefined },
    ]);
  });
});

describe("panels: day parts and models", () => {
  test("human prompts by local hour, at the band boundaries", () => {
    const at = (h: number, m = 0, ms = 0) => T0 + h * HOUR + m * MIN + ms;
    const times = [at(0), at(5, 59, 59_999), at(6), at(11, 59), at(12), at(17, 59, 59_999), at(18), at(23, 59)];
    const evs: Ev[] = [sess("a", T0, { end: T0 + DAY - 1 }), ...times.map((ts) => prompt("a", ts)), prompt("a", at(13), { origin: "scripted" })];
    expect(run(evs).p.dayParts).toEqual({ night: 2, morning: 2, afternoon: 2, evening: 2 });
    // the hour is local: 01:00 UTC is night in UTC and 06:30 (morning) in UTC+05:30
    const one: Ev[] = [sess("a", T0), prompt("a", at(1))];
    expect(run(one).p.dayParts).toEqual({ night: 1, morning: 0, afternoon: 0, evening: 0 });
    expect(run(one, { timeZone: "Asia/Kolkata" }).p.dayParts).toEqual({ night: 0, morning: 1, afternoon: 0, evening: 0 });
  });

  test("privateModels: raw model id → sessions using it", () => {
    const { p } = run([sess("a", T0, { models: ["m-1", "m-2"] }), prompt("a", T0), sess("b", T0 + DAY, { models: ["m-1"] }), prompt("b", T0 + DAY),
      sess("k", T0, { parentId: "a", origin: "subagent", models: ["m-3"] })]);
    expect(p.privateModels).toEqual({ "m-1": 2, "m-2": 1 });
  });

  test("privateModels: a model id named like an Object.prototype member is a key like any other; keys are sorted", () => {
    const { p } = run([sess("a", T0, { models: ["toString", "m-2", "constructor", "__proto__"] }), prompt("a", T0),
      sess("b", T0 + DAY, { models: ["constructor", "valueOf"] }), prompt("b", T0 + DAY)]);
    expect(Object.entries(p.privateModels)).toEqual([["__proto__", 1], ["constructor", 2], ["m-2", 1], ["toString", 1], ["valueOf", 1]]);
    expect(Object.getPrototypeOf(p.privateModels)).toBe(Object.prototype);
  });

  test("stack counts have sorted keys, whatever the arrival order", () => {
    const { p } = run([sess("a", T0), prompt("a", T0), tool("a", T0 + 1_000, { category: "edit", editExt: "py" }), tool("a", T0 + 2_000, { category: "edit", editExt: "go" }),
      tool("a", T0 + 3_000, { category: "edit", editExt: "tsx" })]);
    for (const h of [p.stack.languages, p.stack.roleEdits]) expect(Object.keys(h)).toEqual(Object.keys(h).sort());
    expect(Object.keys(p.stack.languages)).toEqual(["go", "js", "py"]);
  });
});

describe("project labels", () => {
  test("5 keys give 5 distinct labels P-XXXX", () => {
    const keys = ["k1", "k2", "k3", "k4", "k5"];
    const labels = projectLabels(SALT, keys);
    expect(labels.size).toBe(5);
    expect(new Set(labels.values()).size).toBe(5);
    for (const k of keys) expect(labels.get(k)).toMatch(/^P-[0-9A-F]{4}$/);
    expect(labels.get("k1")).toBe(`P-${keyedHash(SALT, "label:k1").slice(0, 4).toUpperCase()}`);
  });

  test("another salt gives other labels", () => {
    const keys = ["k1", "k2", "k3", "k4", "k5"];
    const a = projectLabels(SALT, keys);
    const b = projectLabels(new Uint8Array(32).fill(8), keys);
    for (const k of keys) expect(b.get(k)).toMatch(/^P-[0-9A-F]{4}$/);
    expect(keys.filter((k) => a.get(k) === b.get(k)).length).toBe(0);
  });

  test("keys whose 4-hex labels collide get 6 hex", () => {
    const seen = new Map<string, string>();
    let pair: [string, string] | undefined;
    for (let i = 0; !pair; i++) {
      const k = `key-${i}`;
      const h = keyedHash(SALT, `label:${k}`).slice(0, 4);
      const was = seen.get(h);
      if (was !== undefined) pair = [was, k];
      else seen.set(h, k);
    }
    const labels = projectLabels(SALT, [...pair, "other"]);
    expect(labels.get(pair[0])).toMatch(/^P-[0-9A-F]{6}$/);
    expect(labels.get(pair[1])).toMatch(/^P-[0-9A-F]{6}$/);
    expect(labels.get(pair[0])).not.toBe(labels.get(pair[1]));
    expect(labels.get("other")).toMatch(/^P-[0-9A-F]{4}$/);
  });

  test("projects: sessions, weeks, tools, repo and last week per project", () => {
    const evs: Ev[] = [
      sess("a", T0, { projectKey: "PA" }), prompt("a", T0), sess("b", T0 + 7 * DAY, { projectKey: "PA", tool: "codex" }), prompt("b", T0 + 7 * DAY, { tool: "codex" }),
      sess("k", T0, { projectKey: "PA", parentId: "a", origin: "subagent" }),
      sess("c", T0, { projectKey: "PB" }), prompt("c", T0),
    ];
    const raw = scanResultOf([...COVERAGE, ...evs], {
      salt: SALT,
      repos: { status: "ok", roots: new Map(), skipped: {}, ms: 0, repos: [{ repoKey: "R", projectKeys: ["PB"], identity: true, commits: [], commitsTruncated: false,
        fileLists: true, instructions: { files: [], namesChecks: [], touched: 0 }, hooks: { entries: 0, checks: [], disabled: false },
        ci: { present: false, checks: [] }, precommit: { present: false, checks: [] } }] },
    });
    const t = buildSessionTable(raw, { timeZone: "UTC" });
    const labels = projectLabels(SALT, ["PA", "PB"]);
    expect(projects(t, labels)).toEqual([
      { key: "PA", label: labels.get("PA")!, sessions: 2, activeWeeks: 2, tools: ["claude-code", "codex"], inRepo: false, lastWeek: "2026-W46" },
      { key: "PB", label: labels.get("PB")!, sessions: 1, activeWeeks: 1, tools: ["claude-code"], inRepo: true, lastWeek: "2026-W45" },
    ]);
  });
});
