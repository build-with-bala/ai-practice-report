// A project exclusion, end to end through the real readers: excluding a project gives what a home in which the project
// never existed gives, apart from the exclusions record.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import path from "node:path";
import { analyze, type Analysis } from "../../core/analyze";
import { exportPayload, scan, type ScanResult } from "../../core/index";
import { ccHistoryLine, CcTranscript, ccSid, slug } from "../fixtures/claude-code";
import { CxRollout, rateLimits, rolloutRel, uuidV7 } from "../fixtures/codex";
import { isolateGitHome, makeRepo } from "../fixtures/repos";
import { fakeHome, type FakeHome } from "../kit/home";

const DAY = 86_400_000;
const MIN = 60_000;
const SALT = new Uint8Array(32).fill(0x5c);
/** All times are fixed off one minute-aligned start a few days back, so both homes hold the same kept data byte for byte. */
const T = Math.floor((Date.now() - 6 * DAY) / MIN) * MIN;
const NOW = T + 6 * DAY;
const OPTS = { timeZone: "UTC", now: NOW } as const;

/** A Claude Code session in `root`: a prompt, an edit and the tests, at `start`. Returns its id and its file. */
function ccSession(h: FakeHome, root: string, label: string, start: number): { sid: string; file: string } {
  const sid = ccSid(label);
  const cc = new CcTranscript(sid, { cwd: root, start }).prompt(`Fix the importer in ${label} and keep the tests green`)
    .tool(`toolu_${label}_e`, "Edit", { file_path: path.join(root, "src", "index.ts"), old_string: "1", new_string: "2" }, { content: "ok" })
    .tool(`toolu_${label}_t`, "Bash", { command: "npm test" }, { content: "ok" })
    .prompt("Now add a test for the empty input");
  return { sid, file: h.writeJsonl(`.claude/projects/${slug(root)}/${sid}.jsonl`, cc.records) };
}

/** A Codex rollout in `root`, with usage-limit readings. Returns its file. */
function cxRollout(h: FakeHome, root: string, n: number, at: number): string {
  const id = uuidV7(at, n);
  const cx = new CxRollout(at, id, { cwd: root, git: false }).meta().turn("t1").user(`Plan the release of ${n}`)
    .event("token_count", { info: null, rate_limits: rateLimits(at, 10 + n) }).done("t1");
  return h.writeJsonl(rolloutRel(at, id), cx.records);
}

interface World { keep: string; secret: string; secretFiles: string[]; k1: string; x1: string }

/** The kept project K and the project X: sessions, a Codex rollout with usage-limit readings, and commits in each repository. */
function build(h: FakeHome): World {
  const keep = makeRepo(path.join(h.env.home, "code", "keep"), [
    { files: { "src/index.ts": "export const one = 1;\n", "CLAUDE.md": "Run `npm test`.\n" }, message: "init", at: T },
    { files: { "src/index.ts": "export const one = 2;\n" }, message: "fix: the importer", at: T + 2 * DAY + 30 * MIN },
  ]);
  const k1 = ccSession(h, keep, "K1", T + 2 * DAY).sid;
  cxRollout(h, keep, 1, T + 3 * DAY);
  const secret = makeRepo(path.join(h.env.home, "code", "secret"), [
    { files: { "src/index.ts": "export const s = 1;\n" }, message: "init", at: T - 20 * DAY },
    { files: { "src/index.ts": "export const s = 2;\n" }, message: "feat: the secret part", at: T + DAY + 40 * MIN },
  ]);
  const x = ccSession(h, secret, "X1", T + DAY);
  const rollout = cxRollout(h, secret, 2, T + 4 * DAY);
  return { keep, secret, secretFiles: [secret, path.dirname(x.file), rollout], k1, x1: x.sid };
}

/**
 * The Claude Code history and config: K's history line, and with `secret` X's (one of its session, three older than every
 * transcript, of sessions whose files are gone) and X's per-project MCP server with a public name; with `historyOnly` a
 * project Y known only from history lines.
 */
function lifetime(h: FakeHome, w: World, o: { secret?: boolean; historyOnly?: boolean }): void {
  const history: Record<string, unknown>[] = [{ ...ccHistoryLine("Fix the importer in K1 and keep the tests green", T + 2 * DAY + 5_000, w.k1), project: w.keep }];
  const projects: Record<string, unknown> = { [w.keep]: { mcpServers: {} } };
  if (o.secret) {
    history.push({ ...ccHistoryLine("Fix the importer in X1 and keep the tests green", T + DAY + 5_000, w.x1), project: w.secret });
    for (let i = 0; i < 3; i++) history.push({ ...ccHistoryLine(`An old request ${i}`, T - (10 + i) * DAY, ccSid(`OLD${i}`)), project: w.secret });
    projects[w.secret] = { mcpServers: { stripe: { type: "stdio", command: "stripe-mcp", args: [] } } };
  }
  if (o.historyOnly) {
    for (let i = 0; i < 4; i++) history.push({ ...ccHistoryLine(`A request from the past ${i}`, T - (30 + i) * DAY, ccSid(`YY${i}`)), project: "/work/only-history" });
  }
  history.sort((a, b) => (a.timestamp as number) - (b.timestamp as number));
  h.writeJsonl(".claude/history.jsonl", history);
  h.writeJson(".claude.json", { numStartups: 3, mcpServers: { github: { type: "stdio", command: "gh-mcp", args: [] } }, projects });
}

let h: FakeHome;
let w: World;
let restore: () => void = () => {};
let withX: ScanResult;
let withoutX: ScanResult;
let withY: ScanResult;
beforeAll(async () => {
  h = fakeHome();
  restore = isolateGitHome(path.join(h.root, "git-home"));
  w = build(h);
  lifetime(h, w, { secret: true });
  withX = await scan({ env: h.env, salt: SALT });
  // the same home without the project: every file of it removed, the history and config rewritten without it
  for (const f of w.secretFiles) rmSync(f, { recursive: true, force: true });
  lifetime(h, w, {});
  withoutX = await scan({ env: h.env, salt: SALT });
  lifetime(h, w, { historyOnly: true });
  withY = await scan({ env: h.env, salt: SALT });
}, 60_000);
afterAll(() => { restore(); h.cleanup(); });

/** The analysis with the exclusions record masked. */
const masked = (a: Analysis): unknown => ({ ...a, exclusions: null });
const exported = (a: Analysis): unknown => ({ ...(JSON.parse(exportPayload(a, { schema: "aiprof/2" }).json) as Record<string, unknown>), exclusions: null });
/** The project keys prompts and sessions of `raw` carry that `other` does not. */
const extraKeys = (raw: ScanResult, other: ScanResult): string[] => {
  const keys = (r: ScanResult) => new Set([...r.store.all("session"), ...r.store.all("prompt"), ...r.store.all("config")].flatMap((e) => (e.projectKey ? [e.projectKey] : [])));
  const known = keys(other);
  return [...keys(raw)].filter((k) => !known.has(k));
};

describe("a project exclusion through the real readers", () => {
  test("excluding the project gives the home in which it never existed, apart from the exclusions record", () => {
    const keys = extraKeys(withX, withoutX);
    expect(keys).toHaveLength(1);
    const ex = analyze(withX, { ...OPTS, exclude: { projects: keys } });
    const never = analyze(withoutX, OPTS);
    expect(ex.exclusions).toMatchObject({ projects: 1 });
    expect(masked(ex)).toEqual(masked(never));
    expect(exported(ex)).toEqual(exported(never));
    // and the project was there to exclude: without the exclusion the two differ
    expect(masked(analyze(withX, OPTS))).not.toEqual(masked(never));
  });

  test("a project known only from history lines can be excluded by its key, and then leaves no trace", () => {
    const keys = extraKeys(withY, withoutX);
    expect(keys).toHaveLength(1);
    const ex = analyze(withY, { ...OPTS, exclude: { projects: keys } });
    const never = analyze(withoutX, OPTS);
    expect(masked(ex)).toEqual(masked(never));
    expect(exported(ex)).toEqual(exported(never));
  });
});
