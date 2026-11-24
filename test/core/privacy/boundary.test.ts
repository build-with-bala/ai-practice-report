// The export boundary as a whole, by mutation: a marker planted in every string field of a real scan, and planted
// values of every shape at every string leaf and record key of rich analyses, never reach the exported bytes or an
// error's text, but for the few channels the payload declares on purpose.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { analyze, type Analysis } from "../../../core/analyze";
import type { Ev } from "../../../core/model/events";
import { EventStore } from "../../../core/model/store";
import { exportPayload } from "../../../core/privacy/export";
import { scan, type ScanResult } from "../../../core/scan";
import { keyedHash } from "../../../core/text/hash";
import { CcTranscript, ccSid, fixtureStart, slug } from "../../fixtures/claude-code";
import { personaScan } from "../../fixtures/personas";
import { makeRepo } from "../../fixtures/repos";
import { buildAll } from "../../kit/allsources";
import { fakeHome } from "../../kit/home";
import { scanResultOf } from "../../kit/scanresult";
import { NOW, TABLE, world } from "../forensics/world";

const OPTS = { schema: "aiprof/2" } as const;
const DAY = 86_400_000;
type Json = Record<string, unknown>;
/** Mutable plain data: the probes rewrite events and analyses field by field. */
type Loose = Record<string, any>;

describe("the boundary under a marker in every string field of a scan", () => {
  const KINDS = ["session", "prompt", "tool", "turn", "usage", "totals", "marker", "config", "daily", "edge", "anchor", "identity", "file", "codex-rollout",
    "codex-thread-row", "ratelimit", "commit", "coverage"] as const;
  /** Three marker shapes: upper-case text, hex (the shape of the one raw channel, identity hashes), and a lower slug. */
  const STYLES: Array<(s: string) => string> = [(s) => `${s}ZZMARKER`, (s) => `${s}c0ffee5eedbead`, (s) => `${s}-zzmark`];
  const MARKS = ["ZZMARKER", "c0ffee5eedbead", "zzmark"];
  /** Join keys that change together, so the data still links. */
  const GROUPS: Record<string, string[]> = {
    sessionIds: ["session.id", "session.parentId", "prompt.sessionId", "tool.sessionId", "tool.delegateTo", "turn.sessionId", "usage.sessionId", "totals.sessionId",
      "marker.sessionId", "edge.parentId", "edge.childId", "identity.sessionId", "codex-rollout.threadId", "codex-thread-row.threadId"],
    projectKeys: ["session.projectKey", "repo.projectKeys", "cwds.key"],
    repoKeys: ["commit.repoKey", "repo.repoKey", "roots.key"],
  };

  test("no marker reaches the bytes or an error's text, whichever field holds it", async () => {
    const h = fakeHome();
    try {
      buildAll(h);
      const roots = ["repo-one", "repo-two"].map((name) => makeRepo(path.join(h.env.home, "code", name), [
        { files: { "CLAUDE.md": `# ${name}\n\nRun \`npm test\`.\n`, "src/index.ts": "export const one = 1;\n" }, message: "init", at: Date.now() - 5 * DAY },
        { files: { "src/index.ts": "export const one = 2;\n" }, message: "fix: it\n\nCo-Authored-By: Claude <noreply@anthropic.com>", at: Date.now() - 2 * DAY },
      ]));
      roots.forEach((root, i) => {
        const sid = ccSid(`REPO${i}`);
        const cc = new CcTranscript(sid, { cwd: root, start: fixtureStart(2 + i) }).prompt("Fix the importer and keep the tests green")
          .tool(`toolu_r${i}_e`, "Edit", { file_path: path.join(root, "src", "index.ts"), old_string: "1", new_string: "2" }, { content: "ok" })
          .tool(`toolu_r${i}_t`, "Bash", { command: "npm test" }, { content: "ok" });
        h.writeJsonl(`.claude/projects/${slug(root)}/${sid}.jsonl`, cc.records);
      });
      const r = await scan({ env: h.env });
      expect(r.repos.repos.length).toBe(2);
      const events: Ev[] = KINDS.flatMap((k) => r.store.all(k) as Ev[]);

      // the units to mutate: every string field (and string list, and record's keys) per event kind, the repo facts, the warnings
      const inGroup = new Map<string, string>();
      for (const [g, fields] of Object.entries(GROUPS)) for (const f of fields) inGroup.set(f, g);
      const fields = new Set<string>(["repo.repoKey", "repo.projectKeys", "repo.commits.shaKey", "repo.commits.files", "repo.commits.ai", "repo.commits.rework",
        "repo.instructions.files", "repo.instructions.namesChecks", "repo.hooks.checks", "repo.ci.checks", "repos.status", "repos.skipped", "warning.detail",
        "warning.source", "warning.code"]);
      for (const e of events) {
        for (const [k, v] of Object.entries(e)) {
          if (k === "k") continue;
          if (typeof v === "string" || (Array.isArray(v) && v.some((x) => typeof x === "string")) || (v !== null && typeof v === "object" && !Array.isArray(v))) fields.add(`${e.k}.${k}`);
        }
      }
      const units = new Set<string>([...fields].map((f) => (inGroup.has(f) ? `group:${inGroup.get(f)}` : f)));
      expect(units.size).toBeGreaterThan(60);

      const rebuild = (unit: string, mut: (s: string) => string): ScanResult => {
        const hit = (field: string): boolean => (unit.startsWith("group:") ? GROUPS[unit.slice(6)]!.includes(field) : unit === field);
        const store = new EventStore();
        for (const e of events) {
          const c = structuredClone(e) as Loose;
          for (const [k, v] of Object.entries(c)) {
            if (k === "k" || !hit(`${c.k}.${k}`)) continue;
            if (typeof v === "string") c[k] = mut(v);
            else if (Array.isArray(v)) c[k] = v.map((x) => (typeof x === "string" ? mut(x) : x));
            else if (v !== null && typeof v === "object") c[k] = Object.fromEntries(Object.entries(v).map(([kk, vv]) => [mut(kk), vv]));
          }
          store.add(c as Ev);
        }
        const rr = structuredClone({ status: r.repos.status, repos: r.repos.repos, skipped: r.repos.skipped, ms: 0 }) as Loose;
        rr.roots = new Map([...r.repos.roots].map(([k, v]) => [hit("roots.key") ? mut(k) : k, v]));
        for (const repo of rr.repos as Loose[]) {
          if (hit("repo.repoKey")) repo.repoKey = mut(repo.repoKey);
          if (hit("repo.projectKeys")) repo.projectKeys = repo.projectKeys.map(mut);
          for (const c of repo.commits as Loose[]) {
            if (hit("repo.commits.shaKey")) c.shaKey = mut(c.shaKey);
            if (hit("repo.commits.files")) c.files = c.files.map(mut);
            if (hit("repo.commits.ai") && c.ai) c.ai = mut(c.ai);
            if (hit("repo.commits.rework") && c.rework) c.rework = mut(c.rework);
          }
          if (hit("repo.instructions.files")) repo.instructions.files = repo.instructions.files.map(mut);
          if (hit("repo.instructions.namesChecks")) repo.instructions.namesChecks = repo.instructions.namesChecks.map(mut);
          if (hit("repo.hooks.checks")) repo.hooks.checks = repo.hooks.checks.map(mut);
          if (hit("repo.ci.checks")) repo.ci.checks = repo.ci.checks.map(mut);
        }
        if (hit("repos.status")) rr.status = mut(rr.status);
        if (hit("repos.skipped")) rr.skipped = Object.fromEntries(Object.entries(rr.skipped as Json).map(([k, v]) => [mut(k), v]));
        const warnings = r.warnings.map((w) => ({ ...w, ...(hit("warning.detail") && w.detail !== undefined ? { detail: mut(w.detail) } : {}),
          ...(hit("warning.source") ? { source: mut(w.source) } : {}), ...(hit("warning.code") ? { code: mut(w.code) } : {}) }));
        const cwds = new Map([...r.cwds].map(([k, v]) => [hit("cwds.key") ? mut(k) : k, v]));
        return { ...r, store, coverage: [...store.all("coverage")], repos: rr as ScanResult["repos"], warnings: warnings as ScanResult["warnings"], cwds };
      };

      const leaks: string[] = [];
      let exported = 0;
      let refused = 0;
      for (const unit of [...units].sort()) {
        for (const [i, mut] of STYLES.entries()) {
          let a: Analysis;
          try { a = analyze(rebuild(unit, mut), { timeZone: "UTC" }); } catch { continue; } // the analysis's own robustness is not this test's
          try {
            const { json } = exportPayload(a, OPTS);
            exported++;
            if (MARKS.some((m) => json.includes(m))) leaks.push(`${unit}/${i} in the bytes`);
          } catch (e) {
            refused++;
            const text = `${(e as Error).message} ${JSON.stringify((e as { paths?: unknown }).paths)}`;
            if (MARKS.some((m) => text.includes(m))) leaks.push(`${unit}/${i} in the error`);
          }
        }
      }
      expect(leaks).toEqual([]);
      expect(exported).toBeGreaterThan(150);
      expect(refused).toBeGreaterThan(0); // a marker in a hex-shaped channel (an identity hash) is refused, not exported
    } finally {
      h.cleanup();
    }
  }, 60_000);
});

describe("the boundary under planted values at every string leaf and record key of an analysis", () => {
  /** Free text, a path, an email, a hex id, a uuid, an ISO time, a day, a month, a week, label-, model- and slug-shaped words, a semver with text. */
  const VALUES = ["Free Text Here", "/Users/jdoe/acme", "jdoe@acme.test", "0123456789abcdef0123456789abcdef", "123e4567-e89b-12d3-a456-426614174000",
    "2026-11-02T10:42:07Z", "2026-11-02", "2026-11", "2026-W45", "P-ACME", "gpt-4o-acme", "acme-payroll", "custom #7", "github", "1.2.3-jdoe.acme"];
  const shape = (p: string): string => p.replace(/\[\d+\]/g, "[]");

  /** The planted values that reached the bytes, as "<path shape> (<mode>) ← <value>", and whether any error text carried one. */
  function plant(base: Analysis): { through: string[]; inError: string[]; runs: number } {
    const shapes = new Map<string, { strings: boolean; keys: boolean }>();
    const survey = (x: unknown, p: string): void => {
      const s = shapes.get(shape(p)) ?? { strings: false, keys: false };
      if (typeof x === "string") shapes.set(shape(p), { ...s, strings: true });
      else if (Array.isArray(x)) x.forEach((y, i) => survey(y, `${p}[${i}]`));
      else if (x !== null && typeof x === "object") {
        shapes.set(shape(p), { ...s, keys: true });
        for (const [k, y] of Object.entries(x)) survey(y, `${p}.${k}`);
      }
    };
    survey(base, "$");
    const baseJson = exportPayload(base, OPTS).json;
    const through: string[] = [];
    const inError: string[] = [];
    let runs = 0;
    for (const [sh, kind] of shapes) {
      for (const val of VALUES) {
        for (const mode of [kind.strings ? "value" : "", kind.keys ? "key" : ""].filter((m) => m !== "")) {
          const a = structuredClone(base) as unknown as Loose;
          let changed = 0;
          const walk = (x: unknown, p: string, parent: Loose, key: string | number): void => {
            if (typeof x === "string") {
              if (mode === "value" && shape(p) === sh) { parent[key] = val; changed++; }
              return;
            }
            if (Array.isArray(x)) { x.forEach((y, i) => walk(y, `${p}[${i}]`, x as unknown as Loose, i)); return; }
            if (x !== null && typeof x === "object") {
              for (const [k, y] of Object.entries(x)) walk(y, `${p}.${k}`, x as Loose, k);
              if (mode === "key" && shape(p) === sh) {
                const first = Object.values(x)[0];
                (x as Loose)[val] = typeof first === "number" ? 3 : structuredClone(first ?? 3);
                changed++;
              }
            }
          };
          walk(a, "$", { $: a }, "$");
          if (changed === 0) continue;
          runs++;
          try {
            const { json } = exportPayload(a as unknown as Analysis, OPTS);
            if (json.includes(JSON.stringify(val).slice(1, -1)) && !baseJson.includes(`"${val}"`)) through.push(`${sh} (${mode}) ← ${val}`);
          } catch (e) {
            if (`${(e as Error).message} ${JSON.stringify((e as { paths?: unknown }).paths)}`.includes(val)) inError.push(`${sh} (${mode}) ← ${val}`);
          }
        }
      }
    }
    return { through: through.sort(), inError, runs };
  }

  test("the forensics world: only a semver version, an ISO week and a public MCP name come through, each where the payload declares it", () => {
    const salt = new Uint8Array(32).fill(7);
    const evs = world().map((x) => x.ev).map((e) => (e.k === "identity" ? { ...e, hash: keyedHash(salt, e.hash) } : e)) as Loose[];
    for (const e of evs) if (e.k === "session" && e.tool === "codex") { e.approval = "on-request"; e.sandbox = "workspace-write"; }
    evs.push({ k: "marker", tool: "claude-code", source: "claude-code.transcripts", ts: Date.UTC(2026, 8, 1, 9), sessionId: "claude-code:A0", kind: "permission-mode",
      detail: "acceptEdits" });
    const a = analyze(scanResultOf(evs as Ev[], { finishedAt: NOW, salt }), { timeZone: "UTC", releases: TABLE });
    const { through, inError, runs } = plant(a);
    expect(runs).toBeGreaterThan(2_000);
    expect(inError).toEqual([]);
    expect(through).toEqual([
      "$.exposure.weekly[].week (value) ← 2026-W45", "$.meta.core (value) ← 1.2.3-jdoe.acme", "$.private.config[].name (value) ← github",
      "$.projects[].lastWeek (value) ← 2026-W45",
    ]);
  }, 60_000);

  test("the expert persona with canaries: only a semver version comes through", () => {
    const { through, inError, runs } = plant(analyze(personaScan("expert", { canaries: true }), { timeZone: "UTC" }));
    expect(runs).toBeGreaterThan(2_000);
    expect(inError).toEqual([]);
    expect(through).toEqual(["$.meta.core (value) ← 1.2.3-jdoe.acme"]);
  }, 60_000);
});
