import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, statSync, symlinkSync, truncateSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ConfigEv, DailyEv } from "../../../core/model/events";
import { scan } from "../../../core/scan";
import { ccConfig, ccHistory, ccStats } from "../../../core/sources/claude-code";
import { commandMarker } from "../../../core/sources/claude-code/history";
import { registry } from "../../../core/sources/registry";
import type { SourcePlugin } from "../../../core/sources/types";
import { keyedHash } from "../../../core/text/hash";
import { CANARY, expectNoCanaries } from "../../kit/canary";
import { fakeHome, type FakeHome } from "../../kit/home";
import { buildCcLifetime, CC_H1, CC_H2, CC_HAIKU, CC_OPUS, ccHistoryLine, ccSid, nzdt } from "../../fixtures/claude-code";

let h: FakeHome;
beforeEach(() => { h = fakeHome(); });
afterEach(() => h.cleanup());

const LIFETIME = [ccHistory, ccStats, ccConfig];
const run = (plugins: SourcePlugin[] = LIFETIME) => scan({ env: h.env, plugins });
type Result = Awaited<ReturnType<typeof run>>;
/** Plugins run concurrently, so coverage arrives in completion order; compare it sorted by source. */
const covSummary = (r: Result) => r.coverage.map((c) => [c.source, c.window, c.status]).sort();
const configs = (r: Result, kind: ConfigEv["kind"]) => r.store.all("config").filter((c) => c.kind === kind);
const skipChmod = process.platform === "win32" || process.getuid?.() === 0;
const DAY_MS = 86_400_000;

/**
 * The history DailyEvs of a scan of the fake home run in a child process with `TZ=<tz>`. The zone is set in the child
 * because switching it inside `bun test` is unreliable: in Bun 1.3, once any test file deletes `process.env.TZ`, later
 * assignments are ignored for the rest of the process.
 */
function historyDaysIn(tz: string): { zone: string; days: [string, number][] } {
  const url = (rel: string) => JSON.stringify(pathToFileURL(path.resolve(import.meta.dir, rel)).href);
  const code = [
    `const { scan } = await import(${url("../../../core/scan.ts")});`,
    `const { ccHistory } = await import(${url("../../../core/sources/claude-code/index.ts")});`,
    `const r = await scan({ env: JSON.parse(process.env.AIPR_TEST_ENV), plugins: [ccHistory] });`,
    `console.log(JSON.stringify({ zone: new Intl.DateTimeFormat().resolvedOptions().timeZone, days: r.store.all("daily").map((d) => [d.day, d.count]) }));`,
  ].join("\n");
  const child = Bun.spawnSync({
    cmd: [process.execPath, "-e", code],
    env: { ...process.env, TZ: tz, AIPR_TEST_ENV: JSON.stringify(h.env) },
    stdout: "pipe", stderr: "pipe",
  });
  if (child.exitCode !== 0) throw new Error(`child scan failed: ${child.stderr.toString()}`);
  return JSON.parse(child.stdout.toString());
}

describe("claude-code lifetime: Task 10 scenario", () => {
  test("history prompts, markers and local days; stats days; identity, hooks, skills, memory files; no canaries", async () => {
    const fx = buildCcLifetime(h);
    expect(fx.aucklandDays).not.toEqual(fx.utcDays);                // the scenario only proves something if the zones disagree
    expect(historyDaysIn("Pacific/Auckland")).toEqual({ zone: "Pacific/Auckland", days: fx.aucklandDays });
    const r = await run();

    const prompts = r.store.all("prompt");
    expect(prompts).toHaveLength(8);
    expect(prompts.every((p) => p.origin === "human" && p.window === "lifetime" && p.source === "claude-code.history")).toBe(true);
    expect(prompts.filter((p) => p.hasPaste === true)).toHaveLength(1);
    const history = r.store.all("marker").filter((m) => m.source === "claude-code.history");
    expect(history.map((m) => [m.kind, m.detail])).toEqual([["model-switch", "opus"], ["effort-switch", "high"], ["clear", undefined]]);

    const daily = r.store.all("daily");
    expect(daily.filter((d) => d.source === "claude-code.history").reduce((n, d) => n + d.count, 0)).toBe(8);
    expect(daily.filter((d) => d.source === "claude-code.history").every((d) => d.zone === "local" && d.unit === "prompts")).toBe(true);
    expect(daily.filter((d) => d.source === "claude-code.stats").map((d) => d.day)).toEqual(fx.statsDays);

    expect(r.store.all("identity")).toEqual([{ k: "identity", tool: "claude-code", source: "claude-code.config", scope: "config", hash: keyedHash(r.salt, "uuid-1") }]);
    expect(configs(r, "hook").find((c) => c.name === "PostToolUse")).toMatchObject({ provenance: "authored", checks: ["test"] });
    const skills = configs(r, "skill");
    expect(skills.find((s) => s.name === "lock-skill")!.provenance).toBe("installed");
    expect(skills.find((s) => s.name === "my-skill")!.provenance).toBe("authored");
    const memory = configs(r, "memory-file");
    expect(memory).toHaveLength(2);
    expect(memory.every((m) => m.name === undefined && m.provenance === "authored")).toBe(true);

    expect(covSummary(r)).toEqual([
      ["claude-code.config", "lifetime", "ok"], ["claude-code.history", "lifetime", "ok"], ["claude-code.stats", "lifetime", "ok"],
    ]);
    expectNoCanaries([r.store, r.coverage, r.warnings], { allow: ["mcp"] });
  });

  test("history days follow the process time zone", () => {
    const fx = buildCcLifetime(h);
    expect(historyDaysIn("UTC")).toEqual({ zone: "UTC", days: fx.utcDays });
  });

  test("history prompts: session ids, task starts, similarity, hashes, paste flags, coverage", async () => {
    const fx = buildCcLifetime(h);
    const r = await run([ccHistory]);
    const p = r.store.all("prompt");
    expect(p.map((x) => x.sessionId)).toEqual([...Array(5).fill(`claude-code:${CC_H1}`), `claude-code:${CC_H2}`, `claude-code:${CC_H2}`, undefined]);
    expect(p.map((x) => x.ts)).toEqual(fx.historyTs);
    expect(p.map((x) => x.features.isTaskStart)).toEqual([true, false, false, false, true, true, false, true]); // /clear follows a 14-hour gap
    expect(p.map((x) => x.intent)).toEqual(["spec", "command", "command", "spec", "command", "spec", "question", "ack"]);
    expect(p.map((x) => x.hasPaste)).toEqual([false, false, false, true, false, false, false, false]);
    expect(p[3]!.features.hasContext).toBe(true);
    expect(p[0]!.features.simToPrev).toBeUndefined();
    expect(p[1]!.features.simToPrev).toBeGreaterThanOrEqual(0);
    expect(p[5]!.features.simToPrev).toBeUndefined();                  // first prompt of its own session
    expect(p[1]!.textHash).toBe(keyedHash(r.salt, "/model opus"));
    const markers = r.store.all("marker");
    expect(markers.map((m) => [m.ts, m.sessionId])).toEqual([[fx.historyTs[1], `claude-code:${CC_H1}`], [fx.historyTs[2], `claude-code:${CC_H1}`], [fx.historyTs[4], `claude-code:${CC_H1}`]]);
    const file = path.join(h.env.home, ".claude", "history.jsonl");
    expect(r.coverage[0]).toMatchObject({
      source: "claude-code.history", window: "lifetime", status: "ok", files: 1, bytes: statSync(file).size, records: 8,
      skipped: {}, unknownTypes: {}, versions: [], from: fx.historyTs[0], to: fx.historyTs[7],
    });
    expect(r.coverage[0]!.retentionDays).toBeUndefined();
  });

  test("stats days: counts, per-day model tokens, UTC-day coverage span", async () => {
    buildCcLifetime(h);
    const r = await run([ccStats]);
    expect(r.store.all("daily")).toEqual([
      { k: "daily", tool: "claude-code", source: "claude-code.stats", day: "2026-01-13", zone: "utc", unit: "messages", count: 120, sessions: 2, toolCalls: 40, models: { [CC_OPUS]: 50_000, [CC_HAIKU]: 4_000 } },
      { k: "daily", tool: "claude-code", source: "claude-code.stats", day: "2026-01-14", zone: "utc", unit: "messages", count: 80, sessions: 1, toolCalls: 25, models: { [CC_OPUS]: 20_000 } },
      { k: "daily", tool: "claude-code", source: "claude-code.stats", day: "2026-01-16", zone: "utc", unit: "messages", count: 10, sessions: 1, toolCalls: 0 },
    ] satisfies DailyEv[]);
    expect(r.coverage[0]).toMatchObject({
      source: "claude-code.stats", window: "lifetime", status: "ok", files: 1, records: 5, unknownTypes: {},
      from: Date.UTC(2026, 0, 13), to: Date.UTC(2026, 0, 16) + DAY_MS - 1,
    });
  });

  test("config: queue total, last plan-mode use, first start, usage merged into skills and plugins, MCP names", async () => {
    const fx = buildCcLifetime(h);
    const r = await run([ccConfig]);
    expect(r.store.all("marker")).toEqual([
      { k: "marker", tool: "claude-code", source: "claude-code.config", ts: fx.lastPlanModeUse, kind: "plan-enter" },
    ]);
    // the lifetime queue total is a count of the CLI's own feature, never a dated marker
    expect(configs(r, "feature")).toEqual([
      { k: "config", tool: "claude-code", source: "claude-code.config", kind: "feature", name: "prompt-queue", provenance: "bundled", uses: 7 },
    ]);
    const skills = configs(r, "skill").map((s) => [s.name, s.provenance, s.uses, s.lastUsed]);
    expect(skills).toEqual([
      ["demo:skill", "installed", 3, fx.skillLastUsed],
      ["lock-skill", "installed", 0, undefined],
      ["my-skill", "authored", 2, fx.skillLastUsed - 60_000],
    ]);
    expect(configs(r, "command").map((c) => [c.name, c.provenance, c.uses])).toEqual([["review-pr", "authored", 0]]);
    expect(configs(r, "agent").map((c) => [c.name, c.provenance])).toEqual([["reviewer", "authored"]]);
    expect(configs(r, "plugin").map((c) => [c.name, c.provenance, c.uses])).toEqual([["demo@market", "installed", 5]]);
    expect(configs(r, "mcp-server").map((c) => [c.name, c.provenance])).toEqual([[CANARY.mcp, "unknown"], ["docs-mcp", "unknown"]]);
    expect(configs(r, "hook").map((c) => [c.name, c.checks])).toEqual([["PostToolUse", ["test"]], ["Stop", []]]);
    const cov = r.coverage[0]!;
    const read = [fx.configFile, ".claude/settings.json", ".claude/plugins/installed_plugins.json", ".agents/.skill-lock.json"];
    expect(cov).toMatchObject({
      source: "claude-code.config", window: "lifetime", status: "ok", files: 4,
      bytes: read.reduce((n, rel) => n + statSync(path.join(h.env.home, rel)).size, 0),
      records: r.store.all("config").length + 2, from: fx.firstStart, to: fx.lastPlanModeUse,
    });
    expect(cov.note).toBeUndefined();
  });
});

describe("claude-code history: local slash commands", () => {
  const cases: [string, ReturnType<typeof commandMarker>][] = [
    ["/model opus", { kind: "model-switch", detail: "opus" }],
    ["/model claude-sonnet-4-5", { kind: "model-switch", detail: "sonnet" }],
    ["/model Haiku", { kind: "model-switch", detail: "haiku" }],
    ["/model opusplan", { kind: "model-switch", detail: "opus" }],
    ["/model fable", { kind: "model-switch", detail: "fable" }],
    ["/model default", { kind: "model-switch", detail: "other" }],
    [`/model ${CANARY.prompt}`, { kind: "model-switch", detail: "other" }],
    ["/model", { kind: "model-switch" }],
    ["/effort high", { kind: "effort-switch", detail: "high" }],
    ["/effort XHIGH", { kind: "effort-switch", detail: "xhigh" }],
    ["/effort low", { kind: "effort-switch", detail: "low" }],
    ["/effort medium please", { kind: "effort-switch", detail: "medium" }],
    ["/effort max", { kind: "effort-switch", detail: "max" }],
    ["/effort auto", { kind: "effort-switch", detail: "other" }],
    ["/effort", { kind: "effort-switch" }],
    ["/clear", { kind: "clear" }],
    ["/clear release-notes", { kind: "clear" }],
    ["/reset", { kind: "clear" }],
    ["/new", { kind: "clear" }],
    ["/compact", { kind: "compact-manual" }],
    ["/compact keep the API notes", { kind: "compact-manual" }],
    ["  /clear  ", { kind: "clear" }],
    ["/models", undefined],
    ["/clearly", undefined],
    ["/new-feature", undefined],
    ["/review src/a.ts", undefined],
    ["model opus", undefined],
    ["please /clear", undefined],
    ["", undefined],
  ];
  for (const [text, want] of cases) test(JSON.stringify(text), () => expect(commandMarker(text)).toEqual(want));

  test("history lines become markers with the prompt's time and session; argument text is never kept", async () => {
    const t0 = nzdt("2026-02-01", "10:00");
    h.writeJsonl(".claude/history.jsonl", [
      ccHistoryLine(`/compact keep ${CANARY.secret}`, t0, CC_H1),
      ccHistoryLine("/model", t0 + 1_000, CC_H1),
      ccHistoryLine("/reset", t0 + 2_000),
      ccHistoryLine(`/effort ${CANARY.token}`, t0 + 3_000, CC_H1),
    ]);
    const r = await run([ccHistory]);
    expect(r.store.all("marker").map((m) => [m.kind, m.detail, m.ts, m.sessionId])).toEqual([
      ["compact-manual", undefined, t0, `claude-code:${CC_H1}`],
      ["model-switch", undefined, t0 + 1_000, `claude-code:${CC_H1}`],
      ["clear", undefined, t0 + 2_000, undefined],
      ["effort-switch", "other", t0 + 3_000, `claude-code:${CC_H1}`],
    ]);
    expect(r.store.all("prompt").map((p) => p.intent)).toEqual(["command", "command", "command", "command"]);
    expectNoCanaries([r.store, r.coverage]);
  });
});

describe("claude-code history: mapping", () => {
  test("session ids: CLI-shaped ids kept, other ids hashed, absent ids omitted", async () => {
    const odd = `${CANARY.project} session`;
    const t0 = nzdt("2026-02-01", "10:00");
    h.writeJsonl(".claude/history.jsonl", [
      ccHistoryLine("first", t0, CC_H1),
      ccHistoryLine("second", t0 + 1_000, odd),
      ccHistoryLine("third", t0 + 2_000, ""),
      ccHistoryLine("fourth", t0 + 3_000),
    ]);
    const r = await run([ccHistory]);
    expect(r.store.all("prompt").map((p) => p.sessionId)).toEqual([`claude-code:${CC_H1}`, `claude-code:${keyedHash(r.salt, odd)}`, undefined, undefined]);
    expectNoCanaries([r.store, r.coverage]);
  });

  test("task starts and similarity follow each session's own prompts, even when sessions interleave", async () => {
    const t0 = nzdt("2026-02-01", "10:00");
    const A = ccSid("A"), B = ccSid("B");
    h.writeJsonl(".claude/history.jsonl", [
      ccHistoryLine("Build the export command", t0, A),
      ccHistoryLine("Write the release notes", t0 + 60_000, B),
      ccHistoryLine("Add a --json flag to the export command", t0 + 2 * 60_000, A),
      ccHistoryLine("  shorten them  ", t0 + 20 * 60_000, B),            // 19 min after B's last prompt
      ccHistoryLine("Now document the export command", t0 + 40 * 60_000, A), // 38 min after A's last prompt
    ]);
    const r = await run([ccHistory]);
    const p = r.store.all("prompt");
    expect(p.map((x) => x.features.isTaskStart)).toEqual([true, true, false, false, true]);
    expect(p.map((x) => x.features.simToPrev === undefined)).toEqual([true, true, false, false, false]);
    expect(p[3]!.textHash).toBe(keyedHash(r.salt, "shorten them"));
  });

  test("pasted content is never read: only the presence of entries sets hasPaste", async () => {
    const t0 = nzdt("2026-02-01", "10:00");
    h.writeJsonl(".claude/history.jsonl", [
      ccHistoryLine("[Pasted text #1 +40 lines] fix this", t0, CC_H1, { 1: { id: 1, type: "text", content: CANARY.code } }),
      ccHistoryLine("[Image #1] what is wrong here", t0 + 1_000, CC_H1, { 1: { id: 1, type: "image", content: CANARY.secret, mediaType: "image/png" } }),
      ccHistoryLine("[Pasted text #2 +900 lines]", t0 + 2_000, CC_H1, { 2: { id: 2, type: "text", contentHash: CANARY.token } }),
      ccHistoryLine("no paste here", t0 + 3_000, CC_H1, {}),
      { display: "older line without the field", timestamp: t0 + 4_000, project: CANARY.path },
    ]);
    const r = await run([ccHistory]);
    expect(r.store.all("prompt").map((p) => p.hasPaste)).toEqual([true, true, true, false, false]);
    expect(r.coverage[0]).toMatchObject({ status: "ok", unknownTypes: {} });
    expectNoCanaries([r.store, r.coverage]);
  });

  test("lines without display or timestamp are drift; implausible times and bad lines are skipped; the rest still maps", async () => {
    const t0 = nzdt("2026-02-01", "10:00");
    h.write(".claude/history.jsonl", [
      JSON.stringify(ccHistoryLine("kept", t0, CC_H1)),
      JSON.stringify({ pastedContents: {}, timestamp: t0, project: CANARY.path }),
      JSON.stringify({ display: "no time", pastedContents: {}, project: CANARY.path }),
      JSON.stringify(ccHistoryLine("time zero", 0, CC_H1)),
      JSON.stringify(ccHistoryLine("   ", t0 + 1_000, CC_H1)),
      JSON.stringify([CANARY.prompt]),
      `{"display": "${CANARY.prompt}", "timest`,
      JSON.stringify(ccHistoryLine("also kept", new Date(t0 + 2_000).toISOString(), CC_H1)),
    ].join("\n") + "\n");
    const r = await run([ccHistory]);
    expect(r.store.all("prompt").map((p) => p.ts)).toEqual([t0, t0 + 2_000]);
    expect(r.coverage[0]).toMatchObject({
      status: "drift", records: 7,
      unknownTypes: { "display:missing": 1, "timestamp:missing": 1, "line:not-object": 1 },
      skipped: { "bad-ts": 1, empty: 1, parse: 1 },
    });
    expectNoCanaries([r.store, r.coverage, r.warnings]);
  });

  test("no history file: empty coverage, no events", async () => {
    mkdirSync(path.join(h.env.home, ".claude"), { recursive: true });
    const r = await run([ccHistory]);
    expect(r.coverage).toEqual([{
      k: "coverage", tool: "claude-code", source: "claude-code.history", window: "lifetime", status: "empty", beta: false,
      files: 0, bytes: 0, records: 0, skipped: {}, unknownTypes: {}, versions: [],
    }]);
    expect(r.store.count()).toEqual({ coverage: 1 }); // no event of any other kind
  });

  test("a history.jsonl that is not a regular file counts not-file", async () => {
    mkdirSync(path.join(h.env.home, ".claude", "history.jsonl"), { recursive: true });
    const r = await run([ccHistory]);
    expect(r.coverage[0]).toMatchObject({ status: "empty", files: 0, skipped: { "not-file": 1 } });
  });

  test.skipIf(skipChmod)("an unreadable history file counts as io-error", async () => {
    const file = h.writeJsonl(".claude/history.jsonl", [ccHistoryLine("hello", nzdt("2026-02-01", "10:00"), CC_H1)]);
    chmodSync(file, 0o000);
    try {
      const logs: string[] = [];
      const r = await scan({ env: h.env, plugins: [ccHistory], onLog: (_l, code) => { if (code !== "scan.gc") logs.push(code); } });
      expect(r.coverage[0]).toMatchObject({ status: "empty", files: 0, skipped: { "io-error": 1 } });
      expect(logs).toEqual(["cc.io-error"]);
    } finally {
      chmodSync(file, 0o600);
    }
  });
});

describe("claude-code stats-cache: mapping", () => {
  const stats = (v: unknown) => h.writeJson(".claude/stats-cache.json", v);

  test("model ids are shape-checked before they become keys; non-id keys merge into other", async () => {
    stats({
      version: 5, dailyActivity: [{ date: "2026-02-01", messageCount: 4, sessionCount: 1, toolCallCount: 2 }],
      dailyModelTokens: [
        { date: "2026-02-01", tokensByModel: { [CC_OPUS]: 10, [CANARY.prompt]: 5, "my model!": 7, constructor: 1, "<synthetic>": -3 } },
        { date: "2026-02-01", tokensByModel: { [CC_OPUS]: 2 } },
      ],
      totalSessions: 1, totalMessages: 4,
    });
    const r = await run([ccStats]);
    expect(r.store.all("daily").map((d) => d.models)).toEqual([{ [CC_OPUS]: 12, other: 12, constructor: 1 }]);
    expectNoCanaries([r.store, r.coverage]);
  });

  test("a newer cache version and malformed entries are drift; well-formed days still map", async () => {
    stats({
      version: 99, totalSessions: 1, totalMessages: 6,
      dailyActivity: [
        { date: "2026-02-01", messageCount: 3 },
        { date: "Feb 2", messageCount: 2 },
        { messageCount: 1 },
        { date: "2026-02-03" },
        "2026-02-04",
      ],
      dailyModelTokens: [{ date: "2026-02-01", tokensByModel: [] }],
    });
    const r = await run([ccStats]);
    expect(r.store.all("daily").map((d) => [d.day, d.count, d.sessions, d.toolCalls, d.models])).toEqual([["2026-02-01", 3, undefined, undefined, undefined]]);
    expect(r.coverage[0]).toMatchObject({
      status: "drift", unknownTypes: { "version:newer": 1, "dailyActivity:shape": 4, "dailyModelTokens:shape": 1 },
    });
  });

  test("a cache without dailyActivity is drift", async () => {
    stats({ version: 5, totalSessions: 0, totalMessages: 0 });
    const r = await run([ccStats]);
    expect(r.coverage[0]).toMatchObject({ status: "drift", files: 1, unknownTypes: { "dailyActivity:missing": 1 } });
  });

  test("missing cache is empty; invalid JSON counts as parse", async () => {
    mkdirSync(path.join(h.env.home, ".claude"), { recursive: true });
    expect((await run([ccStats])).coverage[0]).toMatchObject({ status: "empty", files: 0, skipped: {} });
    h.write(".claude/stats-cache.json", `{"version": 5, "dailyActivity": [`);
    expect((await run([ccStats])).coverage[0]).toMatchObject({ status: "empty", files: 0, skipped: { parse: 1 } });
  });
});

describe("claude-code config: mapping", () => {
  const claudeJson = (v: Record<string, unknown>) => h.writeJson(".claude.json", v);
  const skill = (name: string) => h.write(`.claude/skills/${name}/SKILL.md`, `---\nname: ${name}\n---\n${CANARY.prompt}`);

  test("skill usage joins skill folders, then command files; other names: lock or plugin prefix → installed, else unknown", async () => {
    skill("folder-used");
    skill("folder-unused");
    skill("folder-locked");
    h.write(".claude/skills/not-a-skill/README.md", "no SKILL.md here");
    h.write(".claude/skills/.hidden/SKILL.md", "hidden");
    h.write(".claude/skills/stray.md", "a file, not a folder");
    h.write(".claude/commands/cmd-used.md", CANARY.prompt);
    h.write(".claude/commands/notes.txt", "not a command");
    h.writeJson(".agents/.skill-lock.json", { version: 3, skills: { "folder-locked": {}, "lock-only": {} } });
    claudeJson({
      skillUsage: {
        "folder-used": { usageCount: 4, lastUsedAt: nzdt("2026-02-01", "10:00") },
        "cmd-used": { usageCount: 2, lastUsedAt: nzdt("2026-02-01", "11:00") },
        "lock-only": { usageCount: 1 },
        "plug:helper": { usageCount: 6, lastUsedAt: nzdt("2026-02-01", "12:00") },
        init: { usageCount: 9, lastUsedAt: "not a time" },
      },
    });
    const r = await run([ccConfig]);
    expect(configs(r, "skill").map((s) => [s.name, s.provenance, s.uses, s.lastUsed])).toEqual([
      ["folder-locked", "installed", 0, undefined],
      ["folder-unused", "authored", 0, undefined],
      ["folder-used", "authored", 4, nzdt("2026-02-01", "10:00")],
      ["init", "unknown", 9, undefined],
      ["lock-only", "installed", 1, undefined],
      ["plug:helper", "installed", 6, nzdt("2026-02-01", "12:00")],
    ]);
    expect(configs(r, "command").map((c) => [c.name, c.provenance, c.uses, c.lastUsed])).toEqual([["cmd-used", "authored", 2, nzdt("2026-02-01", "11:00")]]);
    expectNoCanaries([r.store, r.coverage]);
  });

  test("without a readable ~/.claude.json the inventory carries no usage, and no identity or markers are emitted", async () => {
    skill("solo");
    h.write(".claude/agents/helper.md", CANARY.prompt);
    const r = await run([ccConfig]);
    expect(r.store.all("config").map((c) => [c.kind, c.name, c.provenance, c.uses])).toEqual([["skill", "solo", "authored", undefined], ["agent", "helper", "authored", undefined]]);
    expect([...r.store.all("identity"), ...r.store.all("marker")]).toEqual([]);
    expect(r.coverage[0]).toMatchObject({ status: "ok", files: 0, records: 2 });
    expect(r.coverage[0]!.from).toBeUndefined();
  });

  test("plugins: installed ids and usage ids, uses from pluginUsage", async () => {
    h.writeJson(".claude/plugins/installed_plugins.json", { version: 2, plugins: { "alpha@market": [{ scope: "user" }], "beta@market": [{ scope: "project" }] } });
    claudeJson({ pluginUsage: { "alpha@market": { usageCount: 3, lastUsedAt: 1, lastUsedNumStartups: 2 }, "gone@market": { usageCount: 1 } } });
    const r = await run([ccConfig]);
    expect(configs(r, "plugin").map((c) => [c.name, c.provenance, c.uses, c.lastUsed])).toEqual([
      ["alpha@market", "installed", 3, undefined], ["beta@market", "installed", 0, undefined], ["gone@market", "installed", 1, undefined],
    ]);
  });

  test("MCP server names come from the global table and every project; definitions and project paths are never read", async () => {
    mkdirSync(path.join(h.env.home, ".claude"), { recursive: true });
    claudeJson({
      mcpServers: { [CANARY.mcp]: { command: CANARY.path, args: [CANARY.secret], env: { TOKEN: CANARY.token } } },
      projects: {
        [CANARY.path]: { mcpServers: { [CANARY.mcp]: { url: `https://${CANARY.host}` }, "proj-only": { headers: { Authorization: CANARY.secret } } } },
        [`${CANARY.path}/other`]: { allowedTools: [CANARY.prompt] },
        "/work/empty": { mcpServers: {} },
      },
      oauthAccount: { emailAddress: CANARY.email, organizationUuid: "org-1" },
    });
    const r = await run([ccConfig]);
    expect(configs(r, "mcp-server").map((c) => c.name)).toEqual([CANARY.mcp, "proj-only"]);
    expect(r.store.all("identity")).toEqual([]);                        // no accountUuid: nothing else in oauthAccount is used
    expectNoCanaries([r.store, r.coverage], { allow: ["mcp"] });
  });

  test("hooks: event names shape-checked, every hook entry classified, command text never kept", async () => {
    h.writeJson(".claude/settings.json", {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "npm run lint && tsc --noEmit" }, { type: "command", command: `echo ${CANARY.secret}` }] }],
        [`${CANARY.project}-hook`]: [{ hooks: [{ type: "command", command: "pytest -q" }] }],
        UserPromptSubmit: [{ hooks: [{ type: "prompt", prompt: CANARY.prompt }] }],
      },
    });
    const r = await run([ccConfig]);
    expect(configs(r, "hook").map((c) => [c.name, c.provenance, c.checks])).toEqual([
      ["PreToolUse", "authored", ["lint", "typecheck"]], ["PreToolUse", "authored", []], ["other", "authored", ["test"]], ["UserPromptSubmit", "authored", undefined],
    ]);
    expectNoCanaries([r.store, r.coverage]);
  });

  test("disableAllHooks: no hook event, one hooks-disabled feature, the entries left out counted; skills keep their firstSeen", async () => {
    h.writeJson(".claude/settings.json", {
      disableAllHooks: true,
      hooks: {
        PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "bun test" }, { type: "command", command: `echo ${CANARY.secret}` }] }],
        Stop: [{ hooks: [{ type: "command", command: "pytest -q" }] }, "not a group"],
      },
    });
    skill("still-listed");
    const r = await run([ccConfig]);
    expect(configs(r, "hook")).toEqual([]);
    expect(configs(r, "feature")).toEqual([
      { k: "config", tool: "claude-code", source: "claude-code.config", kind: "feature", name: "hooks-disabled", provenance: "authored" },
    ]);
    expect(r.coverage[0]).toMatchObject({ skipped: { "hooks-disabled": 3 }, unknownTypes: { "hooks:shape": 1 }, records: 2 });
    expect(configs(r, "skill")[0]!.firstSeen).toBeGreaterThan(0);
    expectNoCanaries([r.store, r.coverage]);
  });

  test("disableAllHooks false, or of another type, leaves the hooks as they are (another type is drift); true with no hooks is the feature alone", async () => {
    const hook = { Stop: [{ hooks: [{ type: "command", command: "make test" }] }] };
    for (const [value, drift] of [[false, {}], ["yes", { "disableAllHooks:type": 1 }]] as const) {
      h.writeJson(".claude/settings.json", { disableAllHooks: value, hooks: hook });
      const r = await run([ccConfig]);
      expect(configs(r, "hook").map((c) => [c.name, c.checks])).toEqual([["Stop", ["test"]]]);
      expect(configs(r, "feature")).toEqual([]);
      expect([r.coverage[0]!.skipped, r.coverage[0]!.unknownTypes]).toEqual([{}, drift]);
    }
    h.writeJson(".claude/settings.json", { disableAllHooks: true });
    const r = await run([ccConfig]);
    expect(configs(r, "feature").map((c) => [c.name, c.provenance])).toEqual([["hooks-disabled", "authored"]]);
    expect(r.coverage[0]!.skipped).toEqual({});
  });

  test("firstSeen: skill folders, command and agent files, and a plugin's cache folder, by stat; nothing on disk, no firstSeen", async () => {
    skill("own");
    h.write(".claude/commands/review.md", CANARY.prompt);
    h.write(".claude/agents/helper.md", CANARY.prompt);
    h.writeJson(".claude/plugins/installed_plugins.json", { version: 2, plugins: { "alpha@market": [{ scope: "user" }], "beta@market": [{ scope: "user" }], "../up@market": [{}] } });
    h.writeJson(".claude/plugins/cache/market/alpha/1.0.0/.claude-plugin/plugin.json", { name: "alpha" });
    h.write(".claude/plugins/cache/up/x", "a cache entry outside the plugin's own folder");
    claudeJson({ skillUsage: { "usage-only": { usageCount: 1 } }, pluginUsage: { "gamma@market": { usageCount: 2 } } });
    const r = await run([ccConfig]);
    const born = (rel: string) => { const st = statSync(path.join(h.env.home, rel)); return Math.floor(st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs); };
    expect(r.store.all("config").filter((c) => c.kind !== "plugin").map((c) => [c.kind, c.name, c.firstSeen])).toEqual([
      ["skill", "own", born(".claude/skills/own")], ["skill", "usage-only", undefined],
      ["command", "review", born(".claude/commands/review.md")], ["agent", "helper", born(".claude/agents/helper.md")],
    ]);
    expect(configs(r, "plugin").map((c) => [c.name, c.firstSeen])).toEqual([
      ["../up@market", undefined], ["alpha@market", born(".claude/plugins/cache/market/alpha")], ["beta@market", undefined], ["gamma@market", undefined],
    ]);
    expect(born(".claude/skills/own")).toBeGreaterThan(0);
    expectNoCanaries([r.store, r.coverage]);
  });

  test.skipIf(process.platform === "win32")("firstSeen follows links: a linked skill folder or command file takes its target's birth", async () => {
    h.write("dotfiles/skills/linked/SKILL.md", "x");
    h.write("dotfiles/commands/linked-cmd.md", "x");
    mkdirSync(path.join(h.env.home, ".claude", "skills"), { recursive: true });
    mkdirSync(path.join(h.env.home, ".claude", "commands"), { recursive: true });
    symlinkSync(path.join(h.env.home, "dotfiles/skills/linked"), path.join(h.env.home, ".claude/skills/linked"));
    symlinkSync(path.join(h.env.home, "dotfiles/commands/linked-cmd.md"), path.join(h.env.home, ".claude/commands/linked-cmd.md"));
    const r = await run([ccConfig]);
    const born = (rel: string) => { const st = statSync(path.join(h.env.home, rel)); return Math.floor(st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs); };
    expect(r.store.all("config").map((c) => [c.kind, c.name, c.firstSeen])).toEqual([
      ["skill", "linked", born("dotfiles/skills/linked")], ["command", "linked-cmd", born("dotfiles/commands/linked-cmd.md")],
    ]);
  });

  test("CLAUDE_CONFIG_DIR: the global config is the one inside that directory", async () => {
    h.env.vars.CLAUDE_CONFIG_DIR = path.join(h.env.home, "alt-claude");
    h.writeJson("alt-claude/.claude.json", { promptQueueUseCount: 2, oauthAccount: { accountUuid: "uuid-alt" } });
    claudeJson({ promptQueueUseCount: 9, oauthAccount: { accountUuid: "uuid-home" } });
    const r = await run([ccConfig]);
    expect(configs(r, "feature").map((c) => c.uses)).toEqual([2]);
    expect(r.store.all("identity").map((i) => i.hash)).toEqual([keyedHash(r.salt, "uuid-alt")]);
  });

  test("a ~/.claude.json over 64 MiB is skipped with a too-large note; settings and folders are still read", async () => {
    const file = h.write(".claude.json", "{}");
    truncateSync(file, 64 * 1024 * 1024 + 1);
    skill("still-read");
    const r = await run([ccConfig]);
    expect(r.coverage[0]).toMatchObject({ status: "ok", note: "too-large", files: 0, skipped: { "too-large": 1 } });
    expect(r.store.all("config").map((c) => [c.name, c.uses])).toEqual([["still-read", undefined]]);
    expect(r.warnings.filter((w) => w.code === "too-large").map((w) => w.source)).toEqual(["claude-code.config"]);
  });

  test("allowlisted fields of an unexpected type are drift; the other fields still map", async () => {
    claudeJson({
      promptQueueUseCount: "7", lastPlanModeUse: { at: 1 }, firstStartTime: 5,
      skillUsage: ["a"], pluginUsage: { "p@m": { usageCount: "3" } }, mcpServers: [CANARY.mcp],
      projects: { "/work/a": { mcpServers: "nope" } },
      oauthAccount: { accountUuid: "uuid-1" },
    });
    h.writeJson(".claude/settings.json", { hooks: [] });
    const r = await run([ccConfig]);
    expect(r.coverage[0]).toMatchObject({
      status: "drift",
      unknownTypes: {
        "promptQueueUseCount:type": 1, "lastPlanModeUse:type": 1, "firstStartTime:type": 1, "skillUsage:type": 1,
        "pluginUsage:shape": 1, "mcpServers:type": 1, "projects.mcpServers:type": 1, "hooks:type": 1,
      },
    });
    expect(r.store.all("identity")).toHaveLength(1);
    expectNoCanaries([r.store, r.coverage], { allow: ["mcp"] });
  });

  test("an unreadable skill lock leaves skill folders with unknown provenance", async () => {
    skill("maybe-installed");
    h.write(".agents/.skill-lock.json", "{not json");
    const r = await run([ccConfig]);
    expect(configs(r, "skill").map((s) => [s.name, s.provenance])).toEqual([["maybe-installed", "unknown"]]);
    expect(r.coverage[0]!.skipped).toEqual({ parse: 1 });
  });

  test.skipIf(process.platform === "win32")("a skill folder that resolves into the plugins cache is installed", async () => {
    h.write(".claude/plugins/cache/market/tools/1.0.0/skills/cached/SKILL.md", "x");
    skill("mine");
    symlinkSync(path.join(h.env.home, ".claude/plugins/cache/market/tools/1.0.0/skills/cached"), path.join(h.env.home, ".claude/skills/cached"));
    const r = await run([ccConfig]);
    expect(configs(r, "skill").map((s) => [s.name, s.provenance])).toEqual([["cached", "installed"], ["mine", "authored"]]);
  });

  test.skipIf(process.platform === "win32")("config files symlinked from a dotfiles folder are read through the link", async () => {
    const settings = h.writeJson("dotfiles/settings.json", { hooks: { Stop: [{ hooks: [{ type: "command", command: "make test" }] }] } });
    const global = h.writeJson("dotfiles/claude.json", { promptQueueUseCount: 1 });
    mkdirSync(path.join(h.env.home, ".claude"), { recursive: true });
    symlinkSync(settings, path.join(h.env.home, ".claude", "settings.json"));
    symlinkSync(global, path.join(h.env.home, ".claude.json"));
    const r = await run([ccConfig]);
    expect(configs(r, "hook").map((c) => [c.name, c.checks])).toEqual([["Stop", ["test"]]]);
    expect(configs(r, "feature").map((c) => [c.name, c.uses])).toEqual([["prompt-queue", 1]]);
    expect(r.store.all("marker")).toEqual([]);
    expect(r.coverage[0]).toMatchObject({ files: 2, bytes: statSync(settings).size + statSync(global).size, skipped: {} });
  });

  test("a global config that is not a regular file is counted as skipped", async () => {
    mkdirSync(path.join(h.env.home, ".claude.json"), { recursive: true });
    mkdirSync(path.join(h.env.home, ".claude"), { recursive: true });
    const r = await run([ccConfig]);
    expect(r.coverage[0]).toMatchObject({ status: "empty", files: 0, skipped: { "not-file": 1 } });
  });

  test("memory files are counted per project folder without being opened", async () => {
    h.write(".claude/projects/-work-a/memory/MEMORY.md", CANARY.prompt);
    h.write(".claude/projects/-work-a/memory/feedback.md", CANARY.secret);
    h.write(".claude/projects/-work-a/memory/notes.txt", "not markdown");
    h.write(".claude/projects/-work-b/memory/MEMORY.md", CANARY.code);
    h.write(".claude/projects/-work-c/s1.jsonl", "");
    const r = await run([ccConfig]);
    expect(configs(r, "memory-file")).toEqual(Array(3).fill({ k: "config", tool: "claude-code", source: "claude-code.config", kind: "memory-file", provenance: "authored" }));
    expectNoCanaries([r.store, r.coverage]);
  });
});

describe("claude-code lifetime: plugins and coverage", () => {
  test("registered in the source registry, P0, one lifetime coverage each", async () => {
    expect(registry.map((p) => p.id)).toEqual(expect.arrayContaining(["claude-code.history", "claude-code.stats", "claude-code.config"]));
    expect(LIFETIME.map((p) => [p.tool, p.tier, p.beta])).toEqual(Array(3).fill(["claude-code", "P0", false]));
    mkdirSync(path.join(h.env.home, ".claude"), { recursive: true });
    const r = await run();
    expect(covSummary(r)).toEqual([
      ["claude-code.config", "lifetime", "empty"], ["claude-code.history", "lifetime", "empty"], ["claude-code.stats", "lifetime", "empty"],
    ]);
  });

  test("no Claude Code directory: absent coverage for each plugin", async () => {
    const r = await run();
    expect(r.coverage.map((c) => [c.source, c.status])).toEqual([
      ["claude-code.history", "absent"], ["claude-code.stats", "absent"], ["claude-code.config", "absent"],
    ]);
  });
});
