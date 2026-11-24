import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { analyze, type Analysis } from "../../../core/analyze";
import { canonicalJson, exportPayload, scan } from "../../../core/index";
import { ExportError, RevealError } from "../../../core/privacy/export";
import { questionFor, type CheckResult } from "../../../core/forensics/index";
import type { ConfigEv, CoverageEv, Ev, FileFactEv, PromptEv, SessionEv } from "../../../core/model/events";
import { MCP_PUBLIC, mcpExportName, mcpLabels, MODEL_WORDS, modelExportId } from "../../../core/privacy/allowlists";
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
/**
 * A hostile value forced into a typed field. The forensic types are closed (a `Reason`, `CheckValues` over `ValueKey`),
 * so a test that plants what no check can produce casts it here, on purpose, to prove the exporter rejects it at run time.
 */
const hostile = <T>(x: unknown): T => x as T;
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
  test("model ids: an allowlist of family, versions, dates and public words; else <family>-other or other (I3)", () => {
    expect(modelExportId("ft:gpt-4o:acme:x:y")).toBe("fine-tuned");
    for (const kept of ["claude-opus-4-1-20250805", "gpt-4o-mini", "gemini-2.5-pro", "o3-mini", "claude-opus-4", "gpt-5.1-codex", "gpt-4o-2024-08-06",
      "claude-3-5-sonnet-20241022", "deepseek", "qwen-2.5-coder"]) expect(`${kept} → ${modelExportId(kept)}`).toBe(`${kept} → ${kept}`);
    expect(modelExportId("gpt-4o-contoso-prod-deployment")).toBe("gpt-other");
    expect(modelExportId("llama-3-acme-hr-finetune")).toBe("llama-other");
    expect(modelExportId(`deepseek${"0123456789abcdef0123456789abcdef01234567"}`)).toBe("deepseek-other");
    expect(modelExportId(`deepseek-${"0123456789abcdef0123456789abcdef01234567"}`)).toBe("deepseek-other");
    expect(modelExportId("gpt--4")).toBe("gpt-other");
    // R2: no letters spelled one version at a time, at most 6 tokens, one real date in a public form
    expect(modelExportId("gpt-1a-1c-1m-1e")).toBe("gpt-other");
    expect(modelExportId("claude-20250805-12345678-12345678-12345678-1234")).toBe("claude-other");
    for (const kept of ["claude-opus-4-1-20250805", "claude-sonnet-4-5", "gpt-4o-mini", "gpt-4o-2024-08-06", "gpt-4-0613", "gpt-5-codex", "gemini-2.5-pro",
      "o3-mini", "deepseek-chat", "llama-3-70b"]) expect(`${kept} → ${modelExportId(kept)}`).toBe(`${kept} → ${kept}`);
    for (const [id, out] of [["gpt-4-20251301", "gpt-other"], ["gpt-4-1332", "gpt-other"], ["gpt-4-2024-02-30", "gpt-other"], ["gpt-4-0613-0613", "gpt-other"],
      ["gpt-4-20240101-2024-01-01", "gpt-other"], ["claude-opus-4-1-2-3-4-5", "claude-other"], ["claude-opus-4-1-2-3-4", "claude-other"],
      ["gpt-4x", "gpt-other"], ["gpt-1234", "gpt-other"], ["gpt-4.123", "gpt-other"], ["gpt-4-2024-08", "gpt-other"], ["gpt-4-2024-02-29", "gpt-4-2024-02-29"],
      ["gpt-4-2023-02-29", "gpt-other"]]) {
      expect(`${id} → ${modelExportId(id)}`).toBe(`${id} → ${out}`);
    }
    // round 3: numbers in the shape public ids have (at most 2 versions, 1–2 digits or a 1–3 digit size, a 1-digit fraction, no leading zero)
    for (const [id, out] of [["claude-3-5-sonnet-417", "claude-other"], ["gpt-4o-2024-08-06-417", "gpt-other"], ["gpt-4o-12-345", "gpt-other"],
      ["gpt-04", "gpt-other"], ["gpt-4.25", "gpt-other"], ["gpt-1.3-13.5", "gpt-1.3-13.5"], ["gpt-1.3-13.5-7", "gpt-other"], ["llama-1000b", "llama-other"],
      ["llama-070b", "llama-other"], ["gpt-4b-mini", "gpt-4b-mini"], ["gpt-4ob", "gpt-other"]]) {
      expect(`${id} → ${modelExportId(id)}`).toBe(`${id} → ${out}`);
    }
    for (const kept of ["claude-opus-4-1-20250805", "claude-sonnet-4-5", "gpt-4o-mini", "gpt-4o-2024-08-06", "gpt-4-0613", "gpt-5-codex", "gemini-2.5-pro",
      "o3-mini", "deepseek-chat", "llama-3-70b", "gpt-5.1-codex", "claude-3-5-sonnet-20241022", "llama-3-405b", "gemini-2.5-flash-lite", "qwen-2.5-0.5b"]) {
      expect(`${kept} → ${modelExportId(kept)}`).toBe(`${kept} → ${kept}`);
    }
    for (const other of ["Claude-Opus-4", "acme/claude-opus", "claude-opus\n4", "claude opus", `claude-${"4-".repeat(40)}4`, `${CANARY.slug}-opus`, "gemma-2", ""]) {
      expect(`${JSON.stringify(other)} → ${modelExportId(other)}`).toBe(`${JSON.stringify(other)} → other`);
    }
    expect(MODEL_WORDS.has("opus") && MODEL_WORDS.has("mini") && !MODEL_WORDS.has("acme")).toBe(true);
    const s: SessionEv = { k: "session", tool: "claude-code", source: "claude-code.transcripts", id: "claude-code:ft-session-0001", window: "detail",
      origin: "human", start: Date.UTC(2026, 10, 10, 12), end: Date.UTC(2026, 10, 10, 13), models: ["ft:gpt-4o:acme:x:y"] };
    const a = analyze(withEvents(personaScan("expert"), [s]), UTC);
    expect(a.private.models["ft:gpt-4o:acme:x:y"]).toBe(1);
    const out = parsed(a);
    expect((out.exposure as Json).models).toMatchObject({ "fine-tuned": 1 });
    expect(JSON.stringify(out)).not.toContain("acme");
  });

  test("150 model ids give 64 keys: the 63 most used and other with the summed rest", () => {
    const a = analyze(personaScan("expert"), UTC);
    const raw: Record<string, number> = { "acme-model": 5 };
    for (let i = 0; i < 150; i++) raw[`gpt-${1 + Math.floor(i / 10)}.${i % 10}`] = i < 3 ? 10 : 1;
    a.private.models = raw;
    const models = (parsed(a).exposure as Json).models as Record<string, number>;
    expect(Object.keys(models).length).toBe(64);
    expect(models["gpt-1.0"]).toBe(10);
    expect(Object.values(models).reduce((x, y) => x + y, 0)).toBe(5 + 3 * 10 + 147);
    expect(models.other).toBe(5 + (150 - 63)); // acme-model, and the 87 least used (ties by id)
  });

  test("ids that map to one export id have their counts summed", () => {
    const a = analyze(personaScan("expert"), UTC);
    a.private.models = { "gpt-4o-contoso-a": 2, "gpt-4o-contoso-b": 3, "gpt-4o": 1, "x-model": 4 };
    expect((parsed(a).exposure as Json).models).toEqual({ "gpt-4o": 1, "gpt-other": 5, other: 4 });
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

  test("without reveal no project has a name; a name failing its pattern fails the export, its text never in the message", () => {
    expect((parsed(a).projects as Json[]).some((p) => "name" in p)).toBe(false);
    const fail = () => exportPayload(a, { ...OPTS, reveal: [{ label: a.projects[0]!.label, name: "x\n<script>" }] });
    expect(fail).toThrow(ExportError);
    try { fail(); } catch (e) {
      expect((e as ExportError).paths).toEqual(["$.projects[0].name"]);
      expect((e as Error).message).not.toContain("script");
    }
  });

  test("a reveal label that names no exported project throws; the last entry for a label wins", () => {
    expect(() => exportPayload(a, { ...OPTS, reveal: [{ label: "P-0000", name: "my-lib" }] })).toThrow(RevealError);
    expect(() => exportPayload(a, { ...OPTS, reveal: [{ label: "not a label", name: "secret-name" }] })).toThrow(/^exportPayload: the reveal label names/);
    const label = a.projects[0]!.label;
    const out = parsed(a, { ...OPTS, reveal: [{ label, name: "first" }, { label: label.toLowerCase(), name: "second" }] });
    expect((out.projects as Json[])[0]!.name).toBe("second");
  });

  test("labels are P- and 4, 6, 8 … 16 upper-case hex; reveal matches one label exactly, never a prefix", () => {
    const b = structuredClone(a);
    expect(b.projects.length).toBeGreaterThanOrEqual(3);
    b.projects[0]!.label = "P-ABCD12";
    b.projects[1]!.label = "P-ABCD34";
    b.projects[2]!.label = "P-ABCD12EF90AB34CD";
    const out = parsed(b, { ...OPTS, reveal: [{ label: "p-abcd12", name: "my-lib" }] });
    const named = (out.projects as Json[]).filter((p) => "name" in p);
    expect(named).toEqual([expect.objectContaining({ label: "P-ABCD12", name: "my-lib" })]);
    expect(() => exportPayload(b, { ...OPTS, reveal: [{ label: "P-ABCD", name: "x" }] })).toThrow(RevealError);
    for (const [label, ok] of [["P-ABCD", true], ["P-ABCDEF01", true], ["P-0123456789ABCDEF", true], ["P-ABCDE", false], ["P-ABC", false],
      ["P-0123456789ABCDEF01", false], ["P-abcd", false]] as const) {
      const c = structuredClone(b);
      c.projects[0]!.label = label;
      let err: unknown;
      try { exportPayload(c, OPTS); } catch (e) { err = e; }
      expect(`${label} ${err === undefined}`).toBe(`${label} ${ok}`);
    }
  });

  test("a reveal label that would name two exported projects throws RevealError, naming neither", () => {
    const b = structuredClone(a);
    b.projects[0]!.label = "P-ABCD12";
    b.projects[1]!.label = "P-ABCD12";
    let err: unknown;
    try { exportPayload(b, { ...OPTS, reveal: [{ label: "P-ABCD12", name: "secret-name" }] }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RevealError);
    expect((err as Error).message).toBe('exportPayload: the reveal label "P-ABCD12" names more than one exported project');
    expect((err as Error).message).not.toContain("secret-name");
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

  test("C5's restore date is exported; a date anywhere else in check values fails the export", () => {
    const a = analyze(personaScan("expert"), UTC);
    const c5 = a.forensics.checks.find((c) => c.id === "C5")!;
    c5.status = "note";
    c5.reason = "restore-cluster";
    c5.values = { violations: 0, date: "2026-11-02", days: 40, clusterFiles: 9 };
    c5.askAbout = "Most trace files were created on 2026-11-02 although their activity spans 40 days. Was this history copied or restored from a backup then?";
    const checks = (parsed(a).forensics as Json).checks as Json[];
    expect(checks.find((c) => c.id === "C5")).toEqual({ id: "C5", status: "note", n: c5.n, reason: "restore-cluster", values: c5.values, tools: c5.tools });
    const c1 = a.forensics.checks.findIndex((c) => c.id === "C1");
    const pathOf = (mutate: (x: Analysis) => void): string[] => {
      const b = structuredClone(a);
      mutate(b);
      try { exportPayload(b, OPTS); } catch (e) { return [...(e as ExportError).paths]; }
      return [];
    };
    // the date key only on C5, and only a real day there
    expect(pathOf((b) => { b.forensics.checks[c1]!.values = { ...b.forensics.checks[c1]!.values, date: "2026-11-03" }; }))
      .toEqual([`$.forensics.checks[${c1}].values.<key>`]);
    const at5 = a.forensics.checks.findIndex((c) => c.id === "C5");
    expect(pathOf((b) => { b.forensics.checks[at5]!.values.date = "2026-02-30"; })).toEqual([`$.forensics.checks[${at5}].values.date`]);
    expect(pathOf((b) => { b.forensics.checks[c1]!.values = hostile({ ...b.forensics.checks[c1]!.values, when: "2026-11-03" }); }))
      .toEqual([`$.forensics.checks[${c1}].values.<key>`]);
  });

  test("each exported check is exactly { id, status, reason, n, tools, values }, and no English text leaves", () => {
    const a = analyze(personaScan("expert"), UTC);
    a.forensics.checks[0]!.askAbout = CANARY.prompt;
    const json = exportPayload(a, OPTS).json;
    expect(json).not.toContain("askAbout");
    expect(json).not.toContain(CANARY.prompt);
    for (const c of (JSON.parse(json).forensics as Json).checks as Json[]) expect(Object.keys(c).sort()).toEqual(["id", "n", "reason", "status", "tools", "values"]);
  });

  test("every check exports its n and its tools", () => {
    const a = analyze(personaScan("expert"), UTC);
    const checks = (parsed(a).forensics as Json).checks as Json[];
    expect(checks.map((c) => [c.id, c.n, c.tools])).toEqual(a.forensics.checks.map((c) => [c.id, c.n, c.tools]));
  });

  test("a reason outside REASONS, an unknown check id or a value outside its kind fails the export, naming paths only", () => {
    const a = analyze(personaScan("expert"), UTC);
    a.forensics.checks[1]!.reason = hostile("Free Text!");
    a.forensics.checks[2]!.id = hostile("C99");
    a.forensics.checks[3]!.values = hostile({ matchShare: 1.5 });
    a.forensics.checks[4]!.values = hostile({ violations: -1 });
    a.forensics.checks[5]!.values = hostile({ rho: -1.5 });
    a.forensics.checks[6]!.values = hostile({ medianCv: -0.1 });
    let err: unknown;
    try { exportPayload(a, OPTS); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ExportError);
    expect((err as ExportError).paths).toEqual(["$.forensics.checks[1].reason", "$.forensics.checks[2].id", "$.forensics.checks[3].values.matchShare",
      "$.forensics.checks[4].values.violations", "$.forensics.checks[5].values.rho", "$.forensics.checks[6].values.medianCv"]);
    expect((err as Error).message).not.toMatch(/Free Text|C99/);
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
    // open records whose entries all pass on: text planted there fails the export instead (tests below)
    const checkValues = new Set<unknown>([...a.forensics.checks.map((c) => c.values), a.private.models, a.risk.permission, a.risk.approval, a.risk.sandbox]);
    let planted = 0;
    const plant = (v: unknown): void => {
      if (Array.isArray(v)) { for (const x of v) plant(x); return; }
      if (v === null || typeof v !== "object") return;
      for (const x of Object.values(v)) plant(x);
      if (checkValues.has(v)) return;
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

  test("text planted in a check's values fails the export: the path names the key, never the value", () => {
    const a = analyze(personaScan("expert"), UTC);
    (a.forensics.checks[3]!.values as Json).zzUnexpected = "LEAKVALUE";
    let err: unknown;
    try { exportPayload(a, OPTS); } catch (e) { err = e; }
    expect((err as ExportError).paths).toEqual(["$.forensics.checks[3].values.<key>"]); // the values are closed: an unlisted key is no key
    expect((err as Error).message).not.toContain("LEAK");
  });

  test("fail closed: a draft the schema would change throws ExportError with the paths only (I4)", () => {
    const base = analyze(personaScan("expert"), UTC);
    const cases: Array<[(a: Analysis) => void, string[]]> = [
      [(a) => { (a.overall as unknown as Json).status = "SCORED"; }, ["$.overall.status"]],
      [(a) => { a.overall.interval = [NaN, 78]; }, ["$.overall.interval[0]"]],
      [(a) => { a.dimensions[0]!.interval = [62.5, 78]; }, ["$.dimensions[0].interval[0]"]],
      [(a) => { a.dimensions[1]!.score = 71.5; }, ["$.dimensions[1].score"]],
      [(a) => { (a.dimensions[2]!.components[0] as unknown as Json).x = Infinity; }, ["$.dimensions[2].components[0].x"]],
      [(a) => { (a.coverage.rows[0]!.sources[0] as Json).status = "SECRET-STATUS"; }, ["$.coverage[0].statuses[0]", "$.coverage[0].statuses"]],
    ];
    for (const [mutate, paths] of cases) {
      const a = structuredClone(base);
      mutate(a);
      let err: unknown;
      try { exportPayload(a, OPTS); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(ExportError);
      expect(paths).toContain((err as ExportError).paths[0]!);
      expect((err as Error).message).not.toMatch(/SCORED|NaN|62\.5|71\.5|Infinity|SECRET/);
    }
  });

  test("the three personas, an empty scan and a lifetime-only scan export without throwing", () => {
    for (const kind of ["novice", "intermediate", "expert"] as const) {
      for (const canaries of [false, true]) expect(() => exportPayload(analyze(personaScan(kind, { canaries }), UTC), OPTS)).not.toThrow();
    }
    expect(() => exportPayload(analyze(scanResultOf([], { finishedAt: Date.UTC(2026, 10, 16) }), UTC), OPTS)).not.toThrow();
    const now = Date.UTC(2026, 10, 16);
    const HIST = "claude-code.history";
    const cov: CoverageEv = { k: "coverage", tool: "claude-code", source: HIST, window: "lifetime", status: "ok", beta: false, files: 1, bytes: 1,
      records: 30, skipped: {}, unknownTypes: {}, versions: [] };
    const prompt = (i: number): PromptEv => ({ k: "prompt", tool: "claude-code", source: HIST, ts: now - (90 - 3 * i) * DAY, window: "lifetime",
      origin: "human", intent: "spec", textHash: `h${i}`,
      features: { words: 8, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: true, techCats: {} } });
    const life = analyze(scanResultOf([cov, ...Array.from({ length: 30 }, (_, i) => prompt(i))], { finishedAt: now }), UTC);
    const out = parsed(life);
    expect(((out.exposure as Json).tenureWeeks as Json).window).toBe("lifetime");
    expect(((out.exposure as Json).activeWeeks as Json).detail).toMatchObject({ value: null, window: "detail" });
  });

  test("required fields: missing or undefined throws with its path; a nullable field stays present as null (I4)", () => {
    const base = analyze(personaScan("expert"), UTC);
    const cases: Array<[(a: Analysis) => void, string]> = [
      [(a) => { (a.overall as unknown as Json).status = undefined; }, "$.overall.status"],
      [(a) => { delete (a.overall as unknown as Json).status; }, "$.overall.status"],
      [(a) => { (a.dimensions[0] as unknown as Json).score = undefined; }, "$.dimensions[0].score"],
      [(a) => { (a.coverage.rows[0] as unknown as Json).tool = undefined; }, "$.coverage[0].tool"],
      [(a) => { (a.forensics.checks[2] as unknown as Json).status = undefined; }, "$.forensics.checks[2].status"],
      [(a) => { (a.dimensions[1]!.components[0] as unknown as Json).x = undefined; }, "$.dimensions[1].components[0].x"],
      [(a) => { (a.dimensions[3] as unknown as Json).interval = undefined; }, "$.dimensions[3].interval"],
      [(a) => { (a.signals.vae as unknown as Json).value = undefined; }, "$.signals.vae.value"],
      [(a) => { (a.exposure.tenureWeeks as unknown as Json).n = undefined; }, "$.exposure.tenureWeeks.n"],
      [(a) => { (a.projects[0] as unknown as Json).sessions = undefined; }, "$.projects[0].sessions"],
    ];
    for (const [mutate, path] of cases) {
      const a = structuredClone(base);
      mutate(a);
      let err: unknown;
      try { exportPayload(a, OPTS); } catch (e) { err = e; }
      expect(`${path} ${err instanceof ExportError}`).toBe(`${path} true`);
      expect((err as ExportError).paths).toEqual([path]);
    }
    const a = structuredClone(base);
    a.dimensions[0]!.score = null;
    a.dimensions[0]!.interval = null;
    const d = (parsed(a).dimensions as Json[])[0]!;
    expect([d.score, d.interval]).toEqual([null, null]);
  });

  test("counts that fold into one key must each be counts: a negative or fractional input fails the export (R5)", () => {
    const base = analyze(personaScan("expert"), UTC);
    const tail: Record<string, number> = {};
    for (let i = 0; i < 70; i++) tail[`gpt-${1 + Math.floor(i / 10)}.${i % 10}`] = i === 69 ? -5 : 100 - i;
    const cases: Array<[(a: Analysis) => void, string]> = [
      [(a) => { a.private.models = { "gpt-acme": 10, "gpt-zz": -5 }; }, "$.exposure.models.gpt-other"],
      [(a) => { a.private.models = { "gpt-acme": 1.5, "gpt-zz": 1.5 }; }, "$.exposure.models.gpt-other"],
      [(a) => { a.risk.permission = { weirdA: 4, weirdB: -4 }; }, "$.risk.permission.other"],
      [(a) => { a.private.models = tail; }, "$.exposure.models.other"],
    ];
    for (const [mutate, path] of cases) {
      const a = structuredClone(base);
      mutate(a);
      let err: unknown;
      try { exportPayload(a, OPTS); } catch (e) { err = e; }
      expect(`${path} ${(err as ExportError | undefined)?.paths?.join(",")}`).toBe(`${path} ${path}`);
    }
    // the projects past 100 sum into otherProjects the same way
    const evs: SessionEv[] = [];
    for (let i = 0; i < 101; i++) {
      evs.push({ k: "session", tool: "codex", source: "codex.rollouts", id: `codex:p${i}`, window: "detail", origin: "human", projectKey: `key${i}`,
        start: Date.UTC(2026, 10, 1) + i * 60_000, end: Date.UTC(2026, 10, 1) + i * 60_000 + 1_000, models: [] });
    }
    const b = analyze(scanResultOf(evs), UTC);
    b.projects[100]!.sessions = -1;
    expect(() => exportPayload(b, OPTS)).toThrow("$.otherProjects.sessions");
  });

  test("a time that is not finite fails the export, even in an optional field (R6)", () => {
    const base = analyze(personaScan("expert"), UTC);
    const cases: Array<[(a: Analysis) => void, string]> = [
      [(a) => { a.signals.vae.from = NaN; }, "$.signals.vae.from"],
      [(a) => { a.coverage.rows[0]!.to = Infinity; }, "$.coverage[0].to"],
      [(a) => { a.exposure.firstSeen.subagents = NaN; }, "$.exposure.firstSeen.subagents"],
      [(a) => { a.exposure.tools[0]!.from = NaN; }, "$.exposure.tools[0].from"],
    ];
    for (const [mutate, path] of cases) {
      const a = structuredClone(base);
      mutate(a);
      let err: unknown;
      try { exportPayload(a, OPTS); } catch (e) { err = e; }
      expect(`${path} ${(err as ExportError | undefined)?.paths?.join(",")}`).toBe(`${path} ${path}`);
    }
  });

  test("any unexpected exception while building surfaces as ExportError naming the stage, never a value (R6)", () => {
    const base = analyze(personaScan("expert"), UTC);
    const cases: Array<(a: Analysis) => void> = [
      (a) => { (a.forensics.checks[0] as unknown as Json).values = undefined; },
      (a) => { (a.identity as unknown as Json).hashes = undefined; },
      (a) => { (a as unknown as Json).projects = "LEAKVALUE"; },
      (a) => { a.signals.vae.from = 1e300; }, // Intl cannot place it
    ];
    for (const mutate of cases) {
      const a = structuredClone(base);
      mutate(a);
      let err: unknown;
      try { exportPayload(a, OPTS); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(ExportError);
      expect((err as ExportError).stage).toBe("build");
      expect((err as Error).message).toBe("exportPayload: the export failed at the build stage");
    }
    expect(new RevealError("P-0000")).toBeInstanceOf(ExportError);
  });

  test("shares and weights lie in [0, 1], the correlation in [-1, 1] (R6)", () => {
    const base = analyze(personaScan("expert"), UTC);
    const cases: Array<[(a: Analysis) => void, string]> = [
      [(a) => { a.forensics.serverBacked = 1.2; }, "$.forensics.serverBacked"],
      [(a) => { a.dimensions[0]!.components[0]!.weight = -0.1; }, "$.dimensions[0].components[0].weight"],
      [(a) => { a.signals.vae.value = 1.5; }, "$.signals.vae.value"],
      [(a) => { a.signals.parallelShare.value = -0.5; }, "$.signals.parallelShare.value"],
      [(a) => { a.signals.rho.value = -1.2; }, "$.signals.rho.value"],
    ];
    for (const [mutate, path] of cases) {
      const a = structuredClone(base);
      mutate(a);
      let err: unknown;
      try { exportPayload(a, OPTS); } catch (e) { err = e; }
      expect(`${path} ${(err as ExportError | undefined)?.paths?.join(",")}`).toBe(`${path} ${path}`);
    }
    const ok = structuredClone(base);
    ok.signals.rho.value = -0.5;
    ok.signals.tokensPerLanded.value = 12_345.6789; // a rate: unbounded
    expect(() => exportPayload(ok, OPTS)).not.toThrow();
  });

  test("a count is never negative (R5)", () => {
    const a = analyze(personaScan("expert"), UTC);
    a.forensics.checks[0]!.n = -1;
    a.exposure.weekly[51]!.activeDays = -2;
    expect(() => exportPayload(a, OPTS)).toThrow(ExportError);
    try { exportPayload(a, OPTS); } catch (e) {
      expect((e as ExportError).paths).toEqual(["$.exposure.weekly[51].activeDays", "$.forensics.checks[0].n"]);
    }
  });

  test("a bad model or risk count is passed on, so the export throws instead of skipping it (R4)", () => {
    const a = analyze(personaScan("expert"), UTC);
    (a.private.models as Json)["gpt-4o"] = "LEAKVALUE";
    (a.risk.permission as unknown as Json).default = "LEAKVALUE";
    let err: unknown;
    try { exportPayload(a, OPTS); } catch (e) { err = e; }
    expect((err as ExportError).paths).toEqual(["$.exposure.models.gpt-4o", "$.risk.permission.default"]);
    expect((err as Error).message).not.toContain("LEAK");
  });

  test("an error path never shows an unlisted key: only declared fields, and record keys that fit their pattern (R3)", () => {
    const a = analyze(personaScan("expert"), UTC);
    (a.forensics.checks[3]!.values as Json)["clients/jdoe acme payroll"] = 1;
    (a.forensics.checks[4]!.values as Json).matchShare = "text";
    let err: unknown;
    try { exportPayload(a, OPTS); } catch (e) { err = e; }
    expect((err as ExportError).paths).toEqual(["$.forensics.checks[3].values.<key>", "$.forensics.checks[4].values.matchShare"]);
    expect((err as Error).message).not.toMatch(/jdoe|acme|payroll|text/);
  });

  test("a time that is not a number fails, even a string already in the target form", () => {
    const base = analyze(personaScan("expert"), UTC);
    const cases: Array<[(a: Analysis) => void, string]> = [
      [(a) => { a.signals.vae.from = hostile("2026-11"); }, "$.signals.vae.from"],
      [(a) => { a.coverage.rows[0]!.from = hostile("2026-11"); }, "$.coverage[0].from"],
      [(a) => { a.exposure.firstSeen.subagents = hostile("2026-W40"); }, "$.exposure.firstSeen.subagents"],
    ];
    for (const [mutate, path] of cases) {
      const a = structuredClone(base);
      mutate(a);
      let err: unknown;
      try { exportPayload(a, OPTS); } catch (e) { err = e; }
      expect(`${path} ${(err as ExportError | undefined)?.paths?.join(",")}`).toBe(`${path} ${path}`);
    }
  });

  test("bad options fail as ExportError at the options stage", () => {
    const a = analyze(personaScan("novice"), UTC);
    for (const o of [undefined, null, {}, { schema: "aiprof/1" }, "aiprof/2"]) {
      let err: unknown;
      try { exportPayload(a, hostile(o)); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(ExportError);
      expect((err as ExportError).stage).toBe("options");
    }
  });

  test("a spoofed ExportError thrown from inside the analysis does not pass through: it becomes a build-stage ExportError", () => {
    const a = analyze(personaScan("novice"), UTC);
    const spoof = Object.create(ExportError.prototype) as ExportError;
    Object.assign(spoof, { message: CANARY.secret, paths: [CANARY.secret] });
    Object.defineProperty(a.identity, "hashes", { get() { throw spoof; } });
    let err: unknown;
    try { exportPayload(a, OPTS); } catch (e) { err = e; }
    expect(err).not.toBe(spoof);
    expect((err as ExportError).stage).toBe("build");
    expect((err as ExportError).paths).toEqual([]);
    expect(String((err as Error).message)).not.toContain(CANARY.secret);
  });

  test("a coverage row exports one status per source, sorted, and no source names", () => {
    const a = analyze(personaScan("expert"), UTC);
    a.coverage.rows[0]!.sources = [{ source: "claude-code.x", status: "ok", beta: false }, { source: "claude-code.y", status: "error", beta: false },
      { source: "claude-code.z", status: "ok", beta: true }];
    const row = (parsed(a).coverage as Json[])[0]!;
    expect(row.statuses).toEqual(["error", "ok", "ok"]);
    expect(row.beta).toBe(true);
    expect(JSON.stringify(row)).not.toContain("claude-code.");
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

describe("the reading side rebuilds every question from the export", () => {
  /** Every exported check's question, rebuilt from the payload, equals the in-memory one; returns how many asked. */
  function rebuildAll(a: Analysis): number {
    const out = JSON.parse(exportPayload(a, OPTS).json) as { forensics: { checks: Array<{ id: unknown; reason: unknown; values: unknown }> } };
    expect(out.forensics.checks.length).toBe(a.forensics.checks.length);
    let asked = 0;
    out.forensics.checks.forEach((c, i) => {
      const mine: CheckResult = a.forensics.checks[i]!;
      expect(c.id).toBe(mine.id);
      expect(`${mine.id} ${questionFor(c.id, c.reason, c.values)}`).toBe(`${mine.id} ${mine.askAbout}`);
      if (mine.askAbout !== undefined) asked++;
    });
    return asked;
  }

  test("the personas and a hand-made scan that raises several checks and flags", () => {
    for (const kind of ["novice", "intermediate", "expert"] as const) rebuildAll(analyze(personaScan(kind, { canaries: true }), UTC));
    // file facts of a restored history (C5 restore cluster), and a regular prompt rhythm, repeated long prompts and a
    // recent burst raised by hand-made scripted-looking sessions
    const raw = personaScan("expert");
    const born = Date.UTC(2026, 10, 2, 9, 30);
    const files: FileFactEv[] = Array.from({ length: 8 }, (_, i) => ({
      k: "file", tool: "claude-code", source: "claude-code.transcripts", pathHash: `f${String(i).padStart(15, "0")}`, bytes: 1_000 + i,
      mtime: born + 60_000, birth: born + i * 1_000, ctime: born + 60_000, firstTs: Date.UTC(2026, 8, 1) + i * DAY, lastTs: Date.UTC(2026, 9, 20) + i * DAY,
    }));
    const a = analyze(withEvents(raw, files), UTC);
    // and checks raised directly with the values their rules give, through the same question function
    const ids = a.forensics.checks.map((c) => c.id);
    const set = (id: CheckResult["id"], r: Partial<CheckResult>): void => {
      const c = a.forensics.checks[ids.indexOf(id)]!;
      Object.assign(c, r);
      const q = questionFor(c.id, c.reason, c.values);
      if (q === undefined) delete c.askAbout;
      else c.askAbout = q;
    };
    set("C1", { status: "fail", reason: "off-time", values: { offShare: 0.0123, p99Seconds: 900, unrecognized: 0, malformed: 0, unverifiedKinds: 0 } });
    set("C2", { status: "fail", reason: "out-of-order", values: { rho: 0.9871, unrecognized: 0, malformed: 0, unverifiedKinds: 0 } });
    set("C3", { status: "warn", reason: "history-mismatch", values: { matchShare: 0.7349, prompts: 120 } });
    set("C4", { status: "note", reason: "several-accounts", values: { matchShare: 1, accounts: 2 } });
    set("soft:recent-burst", { status: "note", reason: "recent-burst", values: { days: 40, recentDays: 22, spanDays: 90, share: 0.55 } });
    set("soft:unclosed-tools", { status: "note", reason: "unclosed-tools", values: { open: 31, share: 0.1033 } });
    expect(rebuildAll(a)).toBeGreaterThanOrEqual(7);
  });

  test("the end-to-end scan of every fixture", async () => {
    const h = fakeHome();
    try {
      buildAll(h);
      const a = analyze(await scan({ env: h.env }), UTC);
      expect(rebuildAll(a)).toBeGreaterThan(0);
    } finally {
      h.cleanup();
    }
  }, 30_000);
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

  test("a richer scan (public and custom MCP labels, a restore date in C5, a revealed name) exports these exact bytes", () => {
    const raw = personaScan("expert");
    const born = Date.UTC(2026, 10, 2, 9, 30);
    const files: FileFactEv[] = Array.from({ length: 8 }, (_, i) => ({
      k: "file", tool: "claude-code", source: "claude-code.transcripts", pathHash: `f${String(i).padStart(15, "0")}`, bytes: 1_000 + i,
      mtime: born + 60_000, birth: born + i * 1_000, ctime: born + 60_000, firstTs: Date.UTC(2026, 8, 1) + i * DAY, lastTs: Date.UTC(2026, 9, 20) + i * DAY,
    }));
    const a = analyze(withEvents(raw, [...files, mcpConfig("github"), mcpConfig("@modelcontextprotocol/server-playwright"), mcpConfig(CANARY.mcp),
      mcpConfig("internal-tools")]), { timeZone: "UTC", seed: 0x5eed });
    const result = withTz("UTC", () => exportPayload(a, { ...OPTS, reveal: [{ label: a.projects[0]!.label, name: "bibliothèque ü-lib" }] }));
    const out = JSON.parse(result.json) as Json;
    expect((out.config as Json).mcpServers).toEqual(["github", "playwright", "custom #1", "custom #2"]);
    const c5 = ((out.forensics as Json).checks as Json[]).find((c) => c.id === "C5")!;
    expect([c5.status, c5.reason, (c5.values as Json).date]).toEqual(["note", "restore-cluster", "2026-11-02"]);
    expect((out.projects as Json[])[0]!.name).toBe("bibliothèque ü-lib");
    expectNoCanaries(result.json);
    expect(result.json).toMatchSnapshot();
  });

  test("persona canaries: the expert with canaries exports none (P3 pre-flight F25)", () => {
    expectNoCanaries(exportPayload(analyze(personaScan("expert", { canaries: true })), { schema: "aiprof/2" }).json);
  });
});
