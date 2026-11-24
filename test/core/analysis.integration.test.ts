// The whole engine end to end: every P0 source's fixtures and two real git repos → scan() → analyze() → exportPayload().
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { analyze, type Analysis } from "../../core/analyze";
import { buildSessionTable, childType, detectEnv, exportPayload, isAction, modelExportId, registry, scan, type Env } from "../../core/index";
import { CcTranscript, ccSid, fixtureStart, slug } from "../fixtures/claude-code";
import { metricMetaProblems } from "../../scripts/smoke-local";
import { makeRepo } from "../fixtures/repos";
import { buildAll } from "../kit/allsources";
import { expectNoCanaries } from "../kit/canary";
import { fakeHome, type FakeHome } from "../kit/home";

const UTC = { timeZone: "UTC" } as const;
const OPTS = { schema: "aiprof/2" } as const;
const DAY = 86_400_000;
/** The export's size bound, in bytes. */
const MAX_EXPORT_BYTES = 300_000;
const DIMENSION_STATUSES = ["scored", "insufficient", "not-measurable", "not-measured"];
const BANDS = ["consistent", "consistent-with-notes", "inconsistent", "unverifiable"];
/** A whole scan and analysis of every fixture: generous, so a stalled CI runner never flakes; a runaway guard only. */
const WHOLE_RUN_MS = 120_000;

/** Every path in `v` whose value is not plain data: a number that is not finite, or an object that is not a plain object or array. */
function impurities(v: unknown, at = "$", out: string[] = []): string[] {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) out.push(`${at}: ${v}`);
  } else if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") {
    out.push(`${at}: ${typeof v}`);
  } else if (v !== null && typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== Array.prototype) out.push(`${at}: ${proto?.constructor?.name ?? "null prototype"}`);
    else for (const [k, x] of Object.entries(v)) impurities(x, `${at}.${k}`, out);
  }
  return out;
}

/** An instruction file that names the test command, and a CI workflow that runs it. */
const repoFiles = (name: string): Record<string, string> => ({
  "CLAUDE.md": `# ${name}\n\nRun \`npm test\` before every commit.\n`,
  "AGENTS.md": "Lint with `npm run lint`, then run `npm test`.\n",
  ".github/workflows/ci.yml": "on: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n",
  "src/index.ts": "export const one = 1;\n",
});

/** A Claude Code session working inside `root`: an edit, then the tests. */
function sessionIn(h: FakeHome, root: string, label: string, daysAgo: number): void {
  const sid = ccSid(label);
  const cc = new CcTranscript(sid, { cwd: root, start: fixtureStart(daysAgo) }).prompt("Fix the importer and keep the tests green")
    .tool(`toolu_${label}_e`, "Edit", { file_path: path.join(root, "src", "index.ts"), old_string: "1", new_string: "2" }, { content: "ok" })
    .tool(`toolu_${label}_t`, "Bash", { command: "npm test" }, { content: "ok" });
  h.writeJsonl(`.claude/projects/${slug(root)}/${sid}.jsonl`, cc.records);
}

/**
 * Every Plan 1 fixture, two real git repos (each with instruction files and CI), and a Claude Code transcript whose cwd
 * is repo 1. Repo signals find repos only from session cwds, so repo 2 gets a session too.
 */
function buildHome(h: FakeHome): string[] {
  buildAll(h);
  const repos = ["repo-one", "repo-two"].map((name) => makeRepo(path.join(h.env.home, "code", name), [
    { files: repoFiles(name), message: "init", at: Date.now() - 5 * DAY },
    { files: { "src/index.ts": "export const one = 2;\n" }, message: "fix: the importer\n\nCo-Authored-By: Claude <noreply@anthropic.com>", at: Date.now() - 2 * DAY },
  ]));
  sessionIn(h, repos[0]!, "REPO1", 2);
  sessionIn(h, repos[1]!, "REPO2", 3);
  return repos;
}

let h: FakeHome;
beforeEach(() => { h = fakeHome(); });
afterEach(() => h.cleanup());

describe("analysis integration: scan → analyze → export, end to end", () => {
  test("every P0 source and two repos: coverage, repo signals, seven dimensions, metric meta, finite numbers, a clean export", async () => {
    buildHome(h);
    const r = await scan({ env: h.env });

    // scan: every P0 plugin reports coverage; repo signals ran and found both repos
    const covered = new Set(r.coverage.map((c) => c.source));
    expect(registry.filter((p) => p.tier === "P0").map((p) => p.id).filter((id) => !covered.has(id))).toEqual([]);
    expect(r.repos.status).toBe("ok");
    expect(r.repos.repos.length).toBe(2);

    const a = analyze(r, UTC);
    expect(a.dimensions.length).toBe(7);
    expect(a.dimensions.filter((d) => !DIMENSION_STATUSES.includes(d.status)).map((d) => `${d.id}:${d.status}`)).toEqual([]);
    const meta = metricMetaProblems(a);
    expect(meta.metrics).toBeGreaterThan(30);
    expect(meta.bad).toEqual([]);
    // repo signals on: the fixture repos' instruction files and CI are measured
    const dimOf = (id: string) => a.dimensions.find((d) => d.id === id)!;
    const compOf = (dimId: string, id: string) => dimOf(dimId).components.find((c) => c.id === id)!;
    expect(dimOf("delivery").status).not.toBe("not-measured");
    // both repos name test commands in their instruction files and run them in CI: each share is 2 of 2
    for (const [dimId, id] of [["verification", "ver.guardrails"], ["context", "ctx.instructions"]] as const) {
      const c = compOf(dimId, id);
      expect([id, c.status, c.n, c.raw, c.meta.sources]).toEqual([id, "ok", 2, 1, ["git"]]);
    }
    expect(impurities(a)).toEqual([]);

    // export: no canary anywhere (no exemptions), within its size bound; analyze is deterministic
    const result = exportPayload(a, OPTS);
    expectNoCanaries(result.json);
    expectNoCanaries(result.value);
    expect(result.bytes).toBeLessThanOrEqual(MAX_EXPORT_BYTES);
    expect(analyze(r, UTC)).toEqual(a);
    expect(BANDS).toContain(a.forensics.band);
    const out = JSON.parse(result.json) as { forensics: { band: string; checks: Array<{ id: string; status: string }> } };
    expect(out.forensics.band).toBe(a.forensics.band);
    expect(out.forensics.checks.map((c) => [c.id, c.status])).toEqual(a.forensics.checks.map((c) => [c.id, c.status]));
  }, WHOLE_RUN_MS);

  test("repo signals off: Delivery, Verification's guardrails and Context's instructions are not-measured", async () => {
    buildHome(h);
    const r = await scan({ env: h.env, repoSignals: false });
    expect(r.repos.status).toBe("off");
    const a = analyze(r, UTC);
    const dim = (id: string) => a.dimensions.find((d) => d.id === id)!;
    const component = (dimId: string, id: string) => dim(dimId).components.find((c) => c.id === id)!;
    expect(dim("delivery").status).toBe("not-measured");
    expect(component("verification", "ver.guardrails").status).toBe("not-measured");
    expect(component("context", "ctx.instructions").status).toBe("not-measured");
    expect(impurities(a)).toEqual([]);
    expectNoCanaries(exportPayload(a, OPTS).json);
  }, WHOLE_RUN_MS);

  test("an empty home (Review Focus 1): a valid export, nothing scored, each dimension with n and needs, forensics unverifiable", async () => {
    const r = await scan({ env: h.env });
    expect(r.repos.status).toBe("ok"); // repo signals are on, but no session cwd names a repo: Delivery has no data
    const a = analyze(r, UTC);
    expect(Object.fromEntries(a.dimensions.map((d) => [d.id, d.status]))).toEqual({
      leverage: "not-measurable", orchestration: "not-measurable", verification: "not-measurable", steering: "not-measurable",
      context: "not-measurable", judgment: "not-measurable", delivery: "not-measurable",
    });
    for (const d of a.dimensions) {
      expect([d.id, Number.isFinite(d.n), Number.isFinite(d.needs) && d.needs > 0]).toEqual([d.id, true, true]);
    }
    expect(a.overall.status).toBe("insufficient");
    expect(a.forensics.band).toBe("unverifiable");
    expect(metricMetaProblems(a).bad).toEqual([]);
    expect(impurities(a)).toEqual([]);
    const result = exportPayload(a, OPTS);
    expect(JSON.parse(result.json)).toEqual(result.value);
    expect(result.bytes).toBeLessThanOrEqual(MAX_EXPORT_BYTES);
    // with repo signals off, the empty home's Delivery is not-measured instead
    const off = analyze(await scan({ env: h.env, repoSignals: false }), UTC);
    expect(off.dimensions.find((d) => d.id === "delivery")!.status).toBe("not-measured");
    expect(impurities(off)).toEqual([]);
  }, WHOLE_RUN_MS);

  test("the value exports the reading apps import through core/index are functions", () => {
    expect([buildSessionTable, isAction, childType, modelExportId, detectEnv].map((f) => typeof f)).toEqual(["function", "function", "function", "function", "function"]);
    const env: Env = detectEnv({ home: "/home/dev" }); // a public option (ScanOptions.env) takes an Env
    expect(env.home).toBe("/home/dev");
  });
});
