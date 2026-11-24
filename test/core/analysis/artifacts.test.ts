import { describe, expect, test } from "bun:test";
import { artifactUse, type ArtifactUse } from "../../../core/analysis/artifacts";
import { buildSessionTable } from "../../../core/analysis/sessions";
import type { Exclusions } from "../../../core/analysis/types";
import type { ConfigEv, CoverageEv, Ev, PromptEv, PromptFeatures, SessionEv, ToolEv } from "../../../core/model/events";
import type { ToolId, Window } from "../../../core/model/ids";
import { keyedHash } from "../../../core/text/hash";
import { scanResultOf } from "../../kit/scanresult";

const T0 = Date.UTC(2026, 10, 2, 9, 0);
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const CC = "claude-code.transcripts";
const CX = "codex.rollouts";
const CONF = "claude-code.config";

const cov = (tool: ToolId, source: string, window: Window): CoverageEv => ({
  k: "coverage", tool, source, window, status: "ok", beta: false, files: 1, bytes: 1, records: 1, skipped: {}, unknownTypes: {}, versions: [],
});
const COVERAGE: Ev[] = [cov("claude-code", CC, "detail"), cov("claude-code", CONF, "lifetime"), cov("codex", CX, "detail")];
const SRC: Partial<Record<ToolId, string>> = { "claude-code": CC, codex: CX };
const sess = (id: string, over: Partial<SessionEv> = {}): SessionEv => {
  const tool = over.tool ?? "claude-code";
  return { k: "session", tool, source: SRC[tool]!, id, window: "detail", origin: "human", start: T0, end: T0 + HOUR, models: [], ...over };
};
const features: PromptFeatures = { words: 6, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: false, techCats: {} };
let hashes = 0;
const prompt = (sessionId: string, ts: number, over: Partial<PromptEv> = {}): PromptEv => {
  const tool = over.tool ?? "claude-code";
  return { k: "prompt", tool, source: SRC[tool]!, ts, sessionId, window: "detail", origin: "human", intent: "spec", textHash: `h${++hashes}`, features, ...over };
};
const tool = (sessionId: string, ts: number, over: Partial<ToolEv> = {}): ToolEv => {
  const t = over.tool ?? "claude-code";
  return { k: "tool", tool: t, source: SRC[t]!, ts, sessionId, name: "Read", category: "read", ...over };
};
const config = (kind: ConfigEv["kind"], name: string, over: Partial<ConfigEv> = {}): ConfigEv =>
  ({ k: "config", tool: "claude-code", source: CONF, kind, name, provenance: "authored", ...over });

function use(evs: Ev[], exclude?: Exclusions): ArtifactUse[] {
  const raw = scanResultOf([...COVERAGE, ...evs]);
  const t = buildSessionTable(raw, { timeZone: "UTC", ...(exclude ? { exclude } : {}) });
  return artifactUse(raw, t);
}
const one = (evs: Ev[], exclude?: Exclusions): ArtifactUse => {
  const out = use(evs, exclude);
  expect(out.length).toBe(1);
  return out[0]!;
};

describe("artifactUse", () => {
  test("an entry with uses > 0 is used, from its config source", () => {
    expect(one([sess("a"), prompt("a", T0), config("skill", "s1", { uses: 3, firstSeen: T0 - HOUR })]))
      .toEqual({ kind: "skill", name: "s1", provenance: "authored", firstSeen: T0 - HOUR, used: true, sources: [CONF] });
  });

  test("an MCP server evidenced only by an in-range call is used, with the call's source; out of range it is not", () => {
    const evs = (ts: number): Ev[] => [sess("a", { start: T0 - 2 * HOUR }), prompt("a", T0), tool("a", ts, { name: "mcp", category: "mcp", mcpServer: "m1" }),
      config("mcp-server", "m1", { provenance: "installed" })];
    expect(one(evs(T0 + MIN), { from: T0 - 10 * MIN })).toEqual({ kind: "mcp-server", name: "m1", provenance: "installed", used: true, sources: [CONF, CC] });
    expect(one(evs(T0 - HOUR), { from: T0 - 10 * MIN })).toMatchObject({ used: false });
  });

  test("a custom agent is used when a child of its type (keyed or raw) is in scope", () => {
    const evs = (agentType: string): Ev[] => [sess("a"), prompt("a", T0), tool("a", T0 + SEC),
      sess("k", { parentId: "a", origin: "subagent", agentType, start: T0 + MIN, end: T0 + 2 * MIN }), tool("k", T0 + MIN + SEC),
      config("agent", "my-agent")];
    expect(one(evs(keyedHash(new Uint8Array(32), "my-agent")))).toEqual({ kind: "agent", name: "my-agent", provenance: "authored", used: true, sources: [CONF, CC] });
    expect(one(evs("my-agent")).used).toBe(true);
    expect(one(evs("other")).used).toBe(false);
  });

  test("an unused entry is listed, unused, with its own provenance and source", () => {
    expect(one([config("plugin", "p1", { provenance: "bundled", uses: 0 })]))
      .toEqual({ kind: "plugin", name: "p1", provenance: "bundled", used: false, sources: [CONF] });
  });

  test("a call of an excluded tool is no evidence", () => {
    const evs: Ev[] = [sess("c", { tool: "codex" }), prompt("c", T0, { tool: "codex" }),
      tool("c", T0 + MIN, { tool: "codex", name: "mcp", category: "mcp", mcpServer: "m1" }), config("mcp-server", "m1")];
    expect(one(evs).used).toBe(true);
    expect(one(evs, { tools: ["codex"] }).used).toBe(false);
  });

  test("the same (kind, name) from two sources is one record: provenance and sources of the entries that show use", () => {
    const evs: Ev[] = [
      config("skill", "s1", { provenance: "authored", uses: 0, firstSeen: T0 }),
      config("skill", "s1", { source: "claude-code.plugins", provenance: "installed", uses: 2, firstSeen: T0 - HOUR }),
    ];
    expect(one(evs)).toEqual({ kind: "skill", name: "s1", provenance: "installed", firstSeen: T0 - HOUR, used: true, sources: ["claude-code.plugins"] });
    const both = one([evs[0]!, { ...(evs[1] as ConfigEv), uses: 0 }]);
    expect(both).toEqual({ kind: "skill", name: "s1", provenance: "authored", firstSeen: T0 - HOUR, used: false, sources: [CONF, "claude-code.plugins"] });
  });

  test("records are sorted by kind and name; non-artifact kinds and nameless entries are left out", () => {
    const out = use([config("skill", "b", { uses: 1 }), config("agent", "z"), config("skill", "a"), config("hook", "PreToolUse"),
      { k: "config", tool: "claude-code", source: CONF, kind: "skill", provenance: "authored", uses: 1 }]);
    expect(out.map((a) => `${a.kind}:${a.name}`)).toEqual(["agent:z", "skill:a", "skill:b"]);
  });
});

describe("a configured MCP server counts once, whatever the number of scopes", () => {
  const T = Date.UTC(2026, 10, 2, 9);
  const mcp = (name: string, projectKey?: string): Ev => ({ k: "config", tool: "claude-code", source: "claude-code.config", kind: "mcp-server", name, provenance: "installed", uses: 2,
    ...(projectKey ? { projectKey } : {}) });
  const evs = (): Ev[] => [
    { k: "session", tool: "claude-code", source: "claude-code.transcripts", id: "a", window: "detail", origin: "human", start: T, end: T + 60_000, models: [], projectKey: "kA" },
    { k: "session", tool: "claude-code", source: "claude-code.transcripts", id: "b", window: "detail", origin: "human", start: T, end: T + 60_000, models: [], projectKey: "kB" },
    mcp("github"), mcp("github", "kA"), mcp("github", "kB"), mcp("stripe", "kB"),
  ];
  test("a server configured globally and per project is one artifact, one config entry and one exported name", async () => {
    const { analyze } = await import("../../../core/analyze");
    const { exportPayload } = await import("../../../core/privacy/export");
    const a = analyze(scanResultOf(evs()), { timeZone: "UTC" });
    expect(a.config.byKind["mcp-server"]).toEqual({ authored: 0, installed: 2, other: 0, used: 2 });
    expect(a.private.config.filter((c) => c.name === "github")).toHaveLength(1);
    const out = JSON.parse(exportPayload(a, { schema: "aiprof/2" }).json) as { config: { mcpServers: string[] } };
    expect(out.config.mcpServers).toEqual(["github", "stripe"]);
  });
  test("a server only an excluded project configures is gone; one another scope configures stays", async () => {
    const { analyze } = await import("../../../core/analyze");
    const { exportPayload } = await import("../../../core/privacy/export");
    const a = analyze(scanResultOf(evs()), { timeZone: "UTC", exclude: { projects: ["kB"] } });
    expect(a.private.config.map((c) => c.name)).toEqual(["github"]);
    const out = JSON.parse(exportPayload(a, { schema: "aiprof/2" }).json) as { config: { mcpServers: string[] } };
    expect(out.config.mcpServers).toEqual(["github"]);
  });
});
