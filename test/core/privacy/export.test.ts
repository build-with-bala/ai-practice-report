import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { analyze, type Analysis } from "../../../core/analyze";
import { canonicalJson, exportPayload, scan } from "../../../core/index";
import type { ConfigEv, Ev, SessionEv } from "../../../core/model/events";
import { MCP_PUBLIC, mcpExportName, mcpLabels, modelExportId } from "../../../core/privacy/allowlists";
import type { ScanResult } from "../../../core/scan";
import { CcTranscript, ccSid, fixtureStart, slug } from "../../fixtures/claude-code";
import { personaScan } from "../../fixtures/personas";
import { makeRepo } from "../../fixtures/repos";
import { buildAll } from "../../kit/allsources";
import { CANARY, expectNoCanaries } from "../../kit/canary";
import { fakeHome, type FakeHome } from "../../kit/home";
import { scanResultOf } from "../../kit/scanresult";
import { withTz } from "../../kit/tz";

const UTC = { timeZone: "UTC" } as const;
const OPTS = { schema: "aiprof/2" } as const;
const DAY = 86_400_000;

type Json = Record<string, unknown>;
const parsed = (a: Analysis, o: Parameters<typeof exportPayload>[1] = OPTS): Json => JSON.parse(exportPayload(a, o).json) as Json;

/** A persona scan with extra events. */
function withEvents(raw: ScanResult, evs: Ev[]): ScanResult {
  for (const e of evs) raw.store.add(e);
  return raw;
}
const mcpConfig = (name: string): ConfigEv => ({ k: "config", tool: "claude-code", source: "claude-code.config", kind: "mcp-server", name, provenance: "authored" });

/** Every string an event or repo fact holds under an id-like key: none of them may reach an export. */
const ID_KEYS = new Set(["id", "sessionId", "parentId", "childId", "projectKey", "repoKey", "projectKeys", "textHash", "callId", "idTail",
  "pathHash", "threadId", "bucket", "detail", "workflowId", "sha", "fileHashes", "files"]);
function rawIds(v: unknown, out: Set<string>, under = false): Set<string> {
  if (typeof v === "string") {
    if (under && v.length >= 8) {
      out.add(v);
      const tail = v.slice(v.indexOf(":") + 1); // a session id's raw part, after its "tool:" prefix
      if (tail.length >= 8) out.add(tail);
    }
  } else if (Array.isArray(v)) for (const x of v) rawIds(x, out, under);
  else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) rawIds(x, out, under || ID_KEYS.has(k));
  return out;
}

describe("exportPayload end to end", () => {
  let h: FakeHome;
  beforeEach(() => { h = fakeHome(); });
  afterEach(() => h.cleanup());

  test("every Plan 1 fixture plus a canary repo: scan → analyze → export holds no canary and no raw id", async () => {
    buildAll(h);
    // a git repo named and filled with canaries, and a Claude Code session working inside it
    const root = makeRepo(path.join(h.root, CANARY.project), [
      { files: { [`${CANARY.project}.ts`]: CANARY.code, "CLAUDE.md": `${CANARY.prompt}\nRun \`npm test\`.\n` }, message: `init ${CANARY.secret}`, at: Date.now() - 4 * DAY },
      { files: { "src/a.ts": CANARY.code }, message: `fix: ${CANARY.prompt}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`, at: Date.now() - 2 * DAY, email: CANARY.email },
    ], { email: CANARY.email });
    const sid = ccSid("REPO");
    const cc = new CcTranscript(sid, { cwd: root, start: fixtureStart(2) }).prompt(`Fix the importer in ${CANARY.path}. ${CANARY.prompt}`)
      .tool("toolu_repo_e", "Edit", { file_path: `${root}/src/a.ts`, old_string: "a", new_string: "b" }, { content: "ok" })
      .tool("toolu_repo_t", "Bash", { command: "npm test" }, { content: "ok" });
    h.writeJsonl(`.claude/projects/${slug(root)}/${sid}.jsonl`, cc.records);

    const r = await scan({ env: h.env });
    expect(r.repos.repos.length).toBeGreaterThan(0); // the canary repo was found and read
    const a = analyze(r, UTC);
    const result = exportPayload(a, OPTS);
    expectNoCanaries(result.json);
    expectNoCanaries(result.value);

    const ids = rawIds([...(["session", "prompt", "tool", "turn", "usage", "totals", "marker", "edge", "anchor", "file", "codex-rollout",
      "codex-thread-row", "ratelimit", "commit"] as const).flatMap((k) => r.store.all(k)), r.repos.repos], new Set());
    expect(r.store.all("anchor").length).toBeGreaterThan(0);
    expect(r.store.all("file").length).toBeGreaterThan(0);
    expect(ids.size).toBeGreaterThan(20);
    expect([...ids].filter((s) => result.json.includes(s))).toEqual([]);
    for (const p of a.projects) expect(result.json).not.toContain(p.key);
    // the labels are exported, and the identity hashes as bindings
    const out = JSON.parse(result.json) as Json;
    expect((out.projects as Json[]).map((p) => p.label)).toEqual(a.projects.slice(0, 100).map((p) => p.label));
    expect((out.identity as Json).bindings).toEqual(a.identity.hashes);
  }, 30_000);
});

describe("exportPayload: raw channels", () => {
  test("a fine-tuned model id exports as fine-tuned; known families keep their id; the rest is other", () => {
    expect(modelExportId("ft:gpt-4o:acme:x:y")).toBe("fine-tuned");
    expect(modelExportId("claude-opus-4")).toBe("claude-opus-4");
    expect(modelExportId("o3-mini")).toBe("o3-mini");
    expect(modelExportId("gpt-5.1-codex")).toBe("gpt-5.1-codex");
    expect(modelExportId(`${CANARY.slug}-opus`)).toBe("other");
    expect(modelExportId("acme/claude-opus")).toBe("other");
    expect(modelExportId(`claude-${"x".repeat(41)}`)).toBe("other");
    const s: SessionEv = { k: "session", tool: "claude-code", source: "claude-code.transcripts", id: "claude-code:ft-session-0001", window: "detail",
      origin: "human", start: Date.UTC(2026, 10, 10, 12), end: Date.UTC(2026, 10, 10, 13), models: ["ft:gpt-4o:acme:x:y"] };
    const a = analyze(withEvents(personaScan("expert"), [s]), UTC);
    expect(a.private.models["ft:gpt-4o:acme:x:y"]).toBe(1);
    const out = parsed(a);
    expect((out.exposure as Json).models).toMatchObject({ "fine-tuned": 1 });
    expect(JSON.stringify(out)).not.toContain("acme");
  });

  test("model counts sum under their export id", () => {
    const a = analyze(personaScan("expert", { canaries: true }), UTC);
    const total = Object.values(a.private.models).reduce((x, y) => x + y, 0);
    const models = (parsed(a).exposure as Json).models as Record<string, number>;
    expect(Object.keys(models)).toEqual(["other"]); // the canary models carry no vendor prefix
    expect(models.other).toBe(total);
  });

  test("an MCP server outside the public list is custom #n; a public one keeps its name; mcpLabels agrees (P3 pre-flight F15)", () => {
    const a = analyze(withEvents(personaScan("expert"), [mcpConfig(CANARY.mcp), mcpConfig("github")]), UTC);
    const out = parsed(a);
    expect((out.config as Json).mcpServers).toEqual(["github", "custom #1"]);
    const labels = mcpLabels(a.private.config);
    expect([...labels.values()].sort()).toEqual(["custom #1", "github"]);
    for (const c of a.private.config.filter((x) => x.kind === "mcp-server")) expect(labels.get(c.key)).toBe(c.name === "github" ? "github" : "custom #1");
    expect(JSON.stringify(out)).not.toContain(CANARY.mcp);
  });

  test("custom servers are numbered in keyed-hash order; names normalize before the public check", () => {
    const cfg = (name: string, key: string) => ({ kind: "mcp-server" as const, name, key, provenance: "authored" as const, used: false });
    const labels = mcpLabels([cfg("zeta", "0002"), cfg("@modelcontextprotocol/server-github", "0003"), cfg("alpha", "0001"), cfg("Sentry-MCP", "0004"),
      { kind: "skill", name: "x", key: "0000", provenance: "authored", used: true }]);
    expect([...labels.entries()].sort()).toEqual([["0001", "custom #1"], ["0002", "custom #2"], ["0003", "github"], ["0004", "sentry"]]);
    expect(mcpExportName("mcp-server-github")).toBe("github");
    expect(mcpExportName("PLAYWRIGHT")).toBe("playwright");
    expect(mcpExportName("@acme/internal")).toBeUndefined();
    expect(MCP_PUBLIC.size).toBe(25);
  });

  test("no session id or project key of a persona appears in the export", () => {
    const raw = personaScan("expert");
    const a = analyze(raw, UTC);
    const json = exportPayload(a, OPTS).json;
    const ids = rawIds(raw.store.all("session"), new Set(), false);
    for (const s of raw.store.all("session")) {
      ids.add(s.id);
      if (s.projectKey !== undefined) ids.add(s.projectKey);
    }
    expect(ids.size).toBeGreaterThan(10);
    expect([...ids].filter((s) => json.includes(s))).toEqual([]);
  });
});

describe("exportPayload: projects and reveal", () => {
  const a = analyze(personaScan("expert"), UTC);

  test("reveal puts the chosen name on that project only; label matching ignores case", () => {
    const target = a.projects[0]!.label;
    const out = parsed(a, { ...OPTS, reveal: [{ label: target.toLowerCase(), name: "my-lib" }] });
    const projects = out.projects as Json[];
    expect(projects.filter((p) => "name" in p)).toEqual([expect.objectContaining({ label: target, name: "my-lib" })]);
  });

  test("without reveal no project has a name; a name failing its pattern is dropped", () => {
    expect((parsed(a).projects as Json[]).some((p) => "name" in p)).toBe(false);
    const bad = parsed(a, { ...OPTS, reveal: [{ label: a.projects[0]!.label, name: "x\n<script>" }] });
    expect((bad.projects as Json[]).some((p) => "name" in p)).toBe(false);
  });

  test("at most 100 projects, ranked by sessions; the rest are counted", () => {
    const evs: SessionEv[] = [];
    for (let i = 0; i < 120; i++) {
      evs.push({ k: "session", tool: "codex", source: "codex.rollouts", id: `codex:p${i}`, window: "detail", origin: "human", projectKey: `key${i}`,
        start: Date.UTC(2026, 10, 1) + i * 60_000, end: Date.UTC(2026, 10, 1) + i * 60_000 + 1_000, models: [] });
    }
    const b = analyze(scanResultOf(evs), UTC);
    const out = parsed(b);
    expect((out.projects as Json[]).length).toBe(100);
    expect(out.otherProjects).toEqual({ projects: 20, sessions: 20 });
    expect((out.projects as Json[]).map((p) => p.label)).toEqual(b.projects.slice(0, 100).map((p) => p.label));
  });
});

describe("exportPayload: no fine timestamps", () => {
  test("no day parts, no epoch ms, no time of day; dates only from C5", () => {
    for (const a of [analyze(personaScan("expert"), UTC), analyze(personaScan("novice", { canaries: true }), UTC)]) {
      const json = exportPayload(a, OPTS).json;
      for (const part of ["night", "morning", "afternoon", "evening", "dayParts"]) expect(json).not.toContain(`"${part}"`);
      expect(json).not.toMatch(/\d{13}/);
      expect(json).not.toMatch(/T\d\d:/);
      const c5 = new Set(a.forensics.checks.filter((c) => c.id === "C5").map((c) => c.values.date).filter((d) => d !== undefined));
      for (const d of json.match(/\d{4}-\d{2}-\d{2}/g) ?? []) expect(c5.has(d)).toBe(true);
    }
  });

  test("C5's restore date is exported; a date anywhere else in check values is not", () => {
    const a = analyze(personaScan("expert"), UTC);
    const c5 = a.forensics.checks.find((c) => c.id === "C5")!;
    c5.status = "note";
    c5.reason = "restore-cluster";
    c5.values = { violations: 0, date: "2026-11-02", days: 40, clusterFiles: 9 };
    c5.askAbout = "Most trace files were created on 2026-11-02 although their activity spans 40 days. Was this history copied or restored from a backup then?";
    const c1 = a.forensics.checks.find((c) => c.id === "C1")!;
    c1.values = { ...c1.values, when: "2026-11-03", p99Seconds: 4 };
    const checks = (parsed(a).forensics as Json).checks as Json[];
    expect(checks.find((c) => c.id === "C5")).toEqual({ id: "C5", status: "note", reason: "restore-cluster", values: c5.values, askAbout: c5.askAbout });
    expect((checks.find((c) => c.id === "C1")!.values as Json).when).toBeUndefined();
    expect((checks.find((c) => c.id === "C1")!.values as Json).p99Seconds).toBe(4);
  });

  test("an askAbout or reason outside its character set or form is dropped", () => {
    const a = analyze(personaScan("expert"), UTC);
    a.forensics.checks[0]!.askAbout = `Ask about ${String.fromCodePoint(0x1f600)}?`;
    a.forensics.checks[1]!.reason = "Free Text!";
    a.forensics.checks[2]!.askAbout = "x".repeat(1_000);
    const checks = (parsed(a).forensics as Json).checks as Json[];
    expect(checks[0]!.askAbout).toBeUndefined();
    expect(checks[1]!.reason).toBeUndefined();
    expect(checks[2]!.askAbout).toBeUndefined();
  });
});

describe("exportPayload: the preview contract and deny by default", () => {
  test("the value is the JSON's parse, and bytes its UTF-8 length", () => {
    const a = analyze(personaScan("expert"), UTC);
    const r = exportPayload(a, { ...OPTS, reveal: [{ label: a.projects[0]!.label, name: "bibliothèque-ü" }] });
    expect(JSON.parse(r.json)).toEqual(r.value);
    expect(r.bytes).toBe(Buffer.byteLength(r.json));
    expect(r.bytes).toBeGreaterThan(r.json.length); // the revealed name is not ASCII
    expect(r.schema).toBe("aiprof/2");
    expect(canonicalJson(r.value)).toBe(r.json);
  });

  test("a property added to a dimension is not exported", () => {
    const a = analyze(personaScan("expert"), UTC);
    (a.dimensions[0] as unknown as Json).secretProperty = 42;
    const out = parsed(a);
    expect((out.dimensions as Json[])[0]).not.toHaveProperty("secretProperty");
    expect(JSON.stringify(out)).not.toContain("secretProperty");
  });

  test("an unexpected key added at every depth of a real analysis never survives", () => {
    const a = analyze(personaScan("expert", { canaries: true }), UTC);
    let planted = 0;
    const plant = (v: unknown): void => {
      if (Array.isArray(v)) { for (const x of v) plant(x); return; }
      if (v === null || typeof v !== "object") return;
      for (const x of Object.values(v)) plant(x);
      (v as Json).zzUnexpected = "LEAKVALUE";
      (v as Json).LEAK_KEY = { nested: "LEAKVALUE" };
      planted++;
    };
    plant(a);
    expect(planted).toBeGreaterThan(100);
    const json = exportPayload(a, OPTS).json;
    expect(json).not.toContain("LEAK");
    expect(json).not.toContain("zzUnexpected");
    expect(json).not.toContain("nested");
  });

  test("the top level holds exactly the declared parts", () => {
    const out = parsed(analyze(personaScan("intermediate"), UTC));
    expect(Object.keys(out).sort()).toEqual(["config", "core", "coverage", "dimensions", "exclusions", "exposure", "forensics", "identity", "otherProjects",
      "overall", "personas", "projects", "reference", "risk", "schema", "signals", "stack"]);
  });

  test("an empty scan exports a valid payload with nothing scored", () => {
    const a = analyze(scanResultOf([], { finishedAt: Date.UTC(2026, 10, 16) }), UTC);
    const r = exportPayload(a, OPTS);
    const out = JSON.parse(r.json) as Json;
    expect((out.overall as Json).status).toBe("insufficient");
    expect((out.dimensions as Json[]).length).toBe(7);
    expect((out.forensics as Json).band).toBe("unverifiable");
    expect(r.json).not.toMatch(/NaN|Infinity/);
  });

  test("risk tokens outside the known ones export as other, with counts summed", () => {
    const a = analyze(personaScan("expert"), UTC);
    a.risk.permission = { default: 2, acceptEdits: 1, [CANARY.slug]: 3, weird: 4 };
    a.risk.approval = { never: 1, [CANARY.slug]: 2 };
    a.risk.sandbox = { "workspace-write": 5, other: 1, [CANARY.project]: 1 };
    expect(parsed(a).risk).toEqual({ permission: { default: 2, acceptEdits: 1, other: 7 }, approval: { never: 1, other: 2 }, sandbox: { "workspace-write": 5, other: 2 } });
  });
});

describe("exportPayload: golden bytes", () => {
  test("the intermediate persona (fixed salt, now, seed, TZ=UTC) exports these exact bytes", () => {
    const result = withTz("UTC", () => exportPayload(analyze(personaScan("intermediate"), { timeZone: "UTC", seed: 0x5eed }), OPTS));
    expect(result.json).toMatchSnapshot();
    const dims = (JSON.parse(result.json) as Json).dimensions as Array<{ components: Array<{ x: number | null; z: number | null }> }>;
    let checked = 0;
    for (const d of dims) {
      for (const c of d.components) {
        for (const v of [c.x, c.z]) {
          if (v === null) continue;
          expect(Math.round(v * 1e4) / 1e4).toBe(v); // at most 4 decimals (pre-flight P22)
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  test("persona canaries: the expert with canaries exports none (P3 pre-flight F25)", () => {
    expectNoCanaries(exportPayload(analyze(personaScan("expert", { canaries: true })), { schema: "aiprof/2" }).json);
  });
});
