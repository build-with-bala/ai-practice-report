import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ciChecks, INSTRUCTION_FILES, mentionedChecks, precommitChecks, readRepoFiles, REPO_FILES, REPO_FOLDERS } from "../../../core/git/files";
import { collectRepoSignals, REPO_SIGNALS_DESCRIBE } from "../../../core/git/index";
import { runGit } from "../../../core/git/run";
import { __observeOpens } from "../../../core/io/observe";
import type { Ev } from "../../../core/model/events";
import { scan, type ScanOptions } from "../../../core/scan";
import { parseHooks } from "../../../core/sources/common/hooks";
import type { Candidate, SourcePlugin } from "../../../core/sources/types";
import { CANARY, expectNoCanaries } from "../../kit/canary";
import { fakeHome, type FakeHome } from "../../kit/home";
import { git, gitVersion, isolateGitHome, makeRepo } from "../../fixtures/repos";

const POSIX = process.platform !== "win32";
const DAY = 86_400_000;
const ago = (days: number) => Date.now() - days * DAY;
/** git 2.37 has `--since-as-filter`. */
const GIT_37 = (([a, b]) => a > 2 || (a === 2 && b >= 37))(gitVersion());

let h: FakeHome;
let restoreHome: () => void = () => {};
beforeEach(() => { h = fakeHome(); restoreHome = isolateGitHome(path.join(h.root, "home")); });
afterEach(() => {
  __observeOpens(undefined);
  restoreHome();
  h.cleanup();
});

/** A plugin that reports one detail-window session per folder (count: how many sessions in it), each folder its own project. */
function sessions(folders: (string | [string, number])[]): SourcePlugin {
  return {
    tool: "codex", id: "fake-sessions", tier: "P0", beta: false, describe: { reads: [], neverReads: [] },
    locate: (): Candidate[] => [{ root: h.root, home: h.root, wsl: false }],
    scan: async (_c, ctx) => {
      let n = 0;
      for (const f of folders) {
        const [dir, count] = typeof f === "string" ? [f, 1] : f;
        const projectKey = ctx.registerCwd(dir);
        for (let i = 0; i < count; i++) {
          const ev: Ev = { k: "session", tool: "codex", source: "fake-sessions", id: `codex:s${n++}`, window: "detail", origin: "human",
            start: ctx.now - 10 * DAY, end: ctx.now - 9 * DAY, models: [], projectKey };
          ctx.emit(ev);
        }
      }
      ctx.emit({ k: "coverage", tool: "codex", source: "fake-sessions", window: "detail", status: "ok", files: 1, bytes: 1, records: n,
        skipped: {}, unknownTypes: {}, versions: [] });
    },
  };
}
const run = (folders: (string | [string, number])[], o: Partial<ScanOptions> = {}) =>
  scan({ env: h.env, plugins: [sessions(folders)], handleSignals: false, ...o });

/** Writes files under `dir` (relative path → content). */
function plant(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

/** A repo at `<root>/<name>` with one commit of `files`, made a few days ago. */
const repoWith = (name: string, files: Record<string, string>) =>
  makeRepo(path.join(h.root, name), [{ files: { "README.txt": "r", ...files }, message: "init", at: ago(3) }]);

/** readRepoFiles of one folder, with real git; `skipped` collects the skip reasons. */
async function read(root: string, cwds: string[] = [], now = Date.now()) {
  const skipped: Record<string, number> = {};
  const facts = await readRepoFiles(root, cwds, { signal: new AbortController().signal, runner: runGit, now, timeoutMs: 10_000, sinceAsFilter: GIT_37,
    skip: (reason) => { skipped[reason] = (skipped[reason] ?? 0) + 1; } });
  return { ...facts, skipped };
}

function link(target: string, at: string): boolean {
  mkdirSync(path.dirname(at), { recursive: true });
  try {
    symlinkSync(target, at);
    return true;
  } catch (e) {
    if (POSIX) throw e;
    return false;
  }
}

describe("the text scanners: commands found in text, as check kinds only", () => {
  test("mentionedChecks: inline code spans, fenced code lines and `$ ` lines; prose never", () => {
    expect(mentionedChecks("Run `bun test` before a commit.\n\n```sh\nnpm run lint\n```\n")).toEqual(["test", "lint"]);
    expect(mentionedChecks("~~~\ncargo clippy\n~~~\n$ tsc --noEmit\n  $ make build\n")).toEqual(["build", "lint", "typecheck"]);
    expect(mentionedChecks("We run pytest and npm test in CI, but say so only in prose.")).toEqual([]);
    expect(mentionedChecks("an unclosed fence:\n```\npytest -q\n")).toEqual(["test"]);
  });

  test("a line of 400,000 backticks, or of spans, is scanned in linear time (the 30 s guard is the bound)", () => {
    expect(mentionedChecks("`".repeat(400_000))).toEqual([]);
    expect(mentionedChecks(`${"``a".repeat(130_000)}`)).toEqual([]);
    expect(mentionedChecks(`\`npm test\` ${"`".repeat(400_000)}`)).toEqual(["test"]);
  }, 30_000);

  test("code spans start at the first backtick of a run", () => {
    expect(mentionedChecks("``npm test``")).toEqual(["test"]);
    expect(mentionedChecks("```npm test`` x")).toEqual([]);
  });

  test("ciChecks: `run:` values, plain, quoted and block scalars; other keys never", () => {
    const yaml = [
      "jobs:", "  test:", "    steps:", "      - uses: actions/checkout@v4", "      - name: pytest is a name, not a command",
      "      - run: |", "          pnpm install", "          pnpm test", "      - name: next", "        run: \"npm run lint\" # quoted",
      "      - run: >-", "          tsc", "          --noEmit", "        env: { CI: 'cargo build' }",
    ].join("\n");
    expect(ciChecks(yaml)).toEqual(["test", "lint", "typecheck"]);
    expect(ciChecks("on: push\njobs:\n  a:\n    steps:\n      - run: echo hi\n")).toEqual([]);
  });

  test("precommitChecks: pre-commit hook ids and entry lines; lefthook run lines; husky script lines", () => {
    expect(precommitChecks("pre-commit", "repos:\n  - repo: x\n    hooks:\n      - id: ruff\n      - id: mypy\n")).toEqual(["lint", "typecheck"]);
    expect(precommitChecks("pre-commit", "repos:\n  - repo: local\n    hooks:\n      - id: unit\n        entry: pytest -q\n      - id: pytest\n")).toEqual(["test"]);
    expect(precommitChecks("pre-commit", "  - id: trailing-whitespace\n  - id: 'eslint'\n")).toEqual(["lint"]);
    expect(precommitChecks("lefthook", "pre-commit:\n  commands:\n    lint:\n      run: npx eslint {staged_files}\n")).toEqual(["lint"]);
    expect(precommitChecks("husky", "#!/usr/bin/env sh\n# pytest in a comment\nnpx vitest run\n")).toEqual(["test"]);
  });

  test("parseHooks: entries per event, checks of command hooks, disableAllHooks; drift reported by key", () => {
    const shapes: string[] = [];
    const p = parseHooks({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "bun test" }, { type: "prompt", prompt: "x" }] }, "bad"],
      "lower-case": [{ hooks: [{ type: "command", command: "tsc --noEmit" }] }] } }, (k) => shapes.push(k));
    expect(p).toMatchObject({ entries: 3, events: ["PostToolUse", "PostToolUse", "other"], checks: ["test", "typecheck"], disabled: false });
    expect(shapes).toEqual(["hooks:shape"]);
    expect(parseHooks({ disableAllHooks: true, hooks: { Stop: [{ hooks: [{ type: "command", command: "make test" }] }] } }))
      .toMatchObject({ entries: 1, events: [], checks: [], disabled: true });
    const drift: string[] = [];
    expect(parseHooks({ disableAllHooks: "yes", hooks: [] }, (k) => drift.push(k))).toMatchObject({ entries: 0, disabled: false });
    expect(drift).toEqual(["disableAllHooks:type", "hooks:type"]);
    expect(parseHooks(undefined)).toEqual({ entries: 0, events: [], entryChecks: [], checks: [], disabled: false });
  });
});

describe("readRepoFiles: the allowlisted repo files, as booleans and counts", () => {
  const cases: [string, Record<string, string>, (f: Awaited<ReturnType<typeof read>>) => void][] = [
    ["CLAUDE.md names `bun test` and has a fenced npm run lint", { "CLAUDE.md": "Run `bun test`.\n\n```sh\nnpm run lint\n```\n" },
      (f) => expect(f.instructions).toMatchObject({ files: ["claude"], namesChecks: ["test", "lint"] })],
    [".cursor/rules/a.mdc exists", { ".cursor/rules/a.mdc": "---\n---\nbe nice\n" }, (f) => expect(f.instructions.files).toContain("cursor-rules")],
    [".github/workflows/ci.yml with a run block holding pnpm test", { ".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n      - run: |\n          pnpm i\n          pnpm test\n" },
      (f) => expect(f.ci).toEqual({ present: true, checks: ["test"] })],
    [".pre-commit-config.yaml with id: ruff", { ".pre-commit-config.yaml": "repos:\n  - repo: r\n    hooks:\n      - id: ruff\n" },
      (f) => expect(f.precommit).toEqual({ present: true, checks: ["lint"] })],
    [".husky/pre-commit with npx vitest run", { ".husky/pre-commit": "npx vitest run\n" }, (f) => expect(f.precommit.checks).toContain("test")],
    [".claude/settings.json PostToolUse hook running bun test", { ".claude/settings.json": JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "bun test" }] }] } }) },
      (f) => expect(f.hooks).toEqual({ entries: 1, checks: ["test"], disabled: false })],
    ["the same, plus disableAllHooks: true", { ".claude/settings.json": JSON.stringify({ disableAllHooks: true, hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "bun test" }] }] } }) },
      (f) => expect(f.hooks).toMatchObject({ disabled: true, checks: [] })],
    ["a 300 KiB CLAUDE.md", { "CLAUDE.md": `\`bun test\`\n${"x".repeat(300 * 1024)}\n` },
      (f) => {
        expect(f.instructions).toMatchObject({ files: ["claude"], namesChecks: [] });
        expect(f.skipped).toEqual({ "file-too-large": 1 });
      }],
    ["every other kind: AGENTS.md, GEMINI.md, .cursorrules, lefthook.yml", { "AGENTS.md": "`go test ./...`", "GEMINI.md": "x", ".cursorrules": "$ make lint", "lefthook.yml": "pre-push:\n  commands:\n    t:\n      run: cargo build\n" },
      (f) => {
        expect(f.instructions).toMatchObject({ files: ["agents", "gemini", "cursorrules"], namesChecks: ["test", "lint"] });
        expect(f.precommit).toEqual({ present: true, checks: ["build"] });
      }],
    ["nothing at all", {}, (f) => {
      expect(f).toEqual({ instructions: { files: [], namesChecks: [], touched: 0 }, hooks: { entries: 0, checks: [], disabled: false },
        ci: { present: false, checks: [] }, precommit: { present: false, checks: [] }, skipped: {} });
    }],
  ];
  for (const [name, files, check] of cases) {
    test(name, async () => check(await read(repoWith("r", files))));
  }

  test("folders: one level only, the allowed endings, at most 64 files each (the rest counted)", async () => {
    const files: Record<string, string> = {
      ".cursor/rules/deep/a.md": "x", ".cursor/rules/notes.txt": "x", ".github/workflows/deep/ci.yml": "run: pytest",
      ".github/workflows/README.md": "run: pytest", ".husky/_/husky.sh": "pytest", ".husky/.gitignore": "pytest",
    };
    for (let i = 0; i < 70; i++) files[`.github/workflows/w${String(i).padStart(2, "0")}.yaml`] = "on: push\n";
    const f = await read(repoWith("r", files));
    expect(f.instructions.files).toEqual([]);
    expect(f.ci).toEqual({ present: true, checks: [] });
    expect(f.precommit).toEqual({ present: false, checks: [] });
    expect(f.skipped).toEqual({ "files-capped": 6 });
  });

  test("CLAUDE.md and AGENTS.md at each session folder inside the repo; folders outside it are not read", async () => {
    const root = repoWith("r", { "pkg/CLAUDE.md": "`pytest`", "app/AGENTS.md": "`npm run build`" });
    const outside = path.join(h.root, "elsewhere");
    plant(outside, { "CLAUDE.md": "`cargo clippy`" });
    const f = await read(root, [path.join(root, "pkg"), path.join(root, "app"), outside, root]);
    expect(f.instructions).toMatchObject({ files: ["claude", "agents"], namesChecks: ["test", "build"] });
  });

  test("instruction history: commits by any author touching an instruction path within 180 days", async () => {
    const root = makeRepo(path.join(h.root, "r"), [
      { files: { "AGENTS.md": "one" }, message: "old", at: ago(200) },
      { files: { "src.ts": "x" }, message: "not an instruction file", at: ago(20) },
      { files: { "AGENTS.md": "two" }, message: "new", at: ago(10), email: "someone@else.test" },
    ]);
    const f = await read(root);
    expect(f.instructions.touched).toBe(1);
    expect(Math.abs(f.instructions.lastTouched! - ago(10))).toBeLessThan(60_000);
    // an instruction file at a session folder inside the repo is an instruction path too
    const sub = makeRepo(path.join(h.root, "s"), [{ files: { "pkg/CLAUDE.md": "x" }, message: "a", at: ago(5) },
      { files: { ".cursor/rules/a.md": "z" }, message: "b", at: ago(4) }]);
    expect((await read(sub)).instructions.touched).toBe(1);
    expect((await read(sub, [path.join(sub, "pkg")])).instructions.touched).toBe(2);
  });

  test("canaries in every file's name and text never reach the facts", async () => {
    const c = `${CANARY.prompt} ${CANARY.secret} ${CANARY.path} ${CANARY.email}`;
    const root = repoWith(CANARY.project, {
      "CLAUDE.md": `${c}\n\`${CANARY.project} test\`\n`, "AGENTS.md": c, "GEMINI.md": c, ".cursorrules": c, [`.cursor/rules/${CANARY.project}.mdc`]: c,
      [`.github/workflows/${CANARY.project}.yml`]: `name: ${c}\njobs:\n  x:\n    steps:\n      - run: echo ${CANARY.secret} && npm test\n`,
      ".pre-commit-config.yaml": `# ${c}\n  - id: ${CANARY.slug}\n    entry: ${CANARY.code}\n`, "lefthook.yml": `x:\n  run: ${c}\n`,
      [`.husky/${CANARY.project}`]: `${c}\n`,
      ".claude/settings.json": JSON.stringify({ hooks: { [CANARY.project]: [{ hooks: [{ type: "command", command: `${CANARY.secret} && npm test` }] }] } }),
    });
    const f = await read(root, [root]);
    expect(f.ci.checks).toEqual(["test"]);
    expect(f.hooks.checks).toEqual(["test"]);
    expectNoCanaries(f);
  });

  test("a never-opened name, or a link to one inside the repo, is present but refused: attempted, never read, counted", async () => {
    const root = repoWith("r", { ".github/workflows/secrets.yaml": "jobs:\n  a:\n    steps:\n      - run: npm test\n" });
    const linked = link("secrets.yaml", path.join(root, ".github", "workflows", "ci.yml"));
    const opened: string[] = [];
    __observeOpens((p) => opened.push(path.basename(p)));
    const f = await read(root);
    __observeOpens(undefined);
    expect(f.ci).toEqual({ present: true, checks: [] }); // neither was read
    expect(f.skipped).toEqual({ "file-refused": linked ? 2 : 1 });
    expect(opened).toEqual(linked ? ["secrets.yaml", "secrets.yaml"] : ["secrets.yaml"]); // a file is opened by its real path
  });

  test("links: followed only to an allowlisted path inside the worktree; out of it, or to any other file, never opened or listed", async () => {
    const root = repoWith("r", { "AGENTS.md": "`pytest`", "src/main.ts": "`cargo build`", "src/hook.sh": "make build" });
    const outside = path.join(h.root, "outside");
    plant(outside, { "secret-note.md": "`make lint`", "rules/diary.md": "`go vet`", "gh/workflows/ci.yml": "run: tsc --noEmit\n" });
    const links: [target: string, at: string][] = [
      ["AGENTS.md", "CLAUDE.md"], // allowed: another allowlisted path inside
      [path.join("src", "main.ts"), "GEMINI.md"], // inside, but a source file
      [path.join(outside, "secret-note.md"), ".cursorrules"], // out of the worktree
      [path.join(outside, "rules"), path.join(".cursor", "rules")], // a folder out of it
      [path.join(outside, "gh"), ".github"], // a link in a parent component
      [path.join("..", "src", "hook.sh"), path.join(".husky", "pre-commit")], // a folder entry to a non-allowlisted file
    ];
    for (const [target, at] of links) if (!link(target, path.join(root, at))) return;
    const opened: string[] = [];
    __observeOpens((p) => opened.push(p));
    const f = await read(root);
    __observeOpens(undefined);
    expect(f.instructions).toMatchObject({ files: ["claude", "agents"], namesChecks: ["test"] });
    expect([f.ci, f.precommit]).toEqual([{ present: false, checks: [] }, { present: false, checks: [] }]);
    expect(f.skipped).toEqual({ "file-outside": 5 });
    const agents = realpathSync.native(path.join(root, "AGENTS.md"));
    expect(opened).toEqual([agents, agents]);
  });

  test("the pass stays interruptible: a timer fires between files, and an abort stops it (counted budget)", async () => {
    const heavy = "`npm test` ".repeat(23_000); // ~250 KiB of command spans per file: slow to scan
    const files: Record<string, string> = {};
    for (let i = 0; i < 64; i++) files[`.cursor/rules/r${String(i).padStart(2, "0")}.md`] = heavy;
    const root = repoWith("r", files);
    const ac = new AbortController();
    let fired = 0;
    const timer = setTimeout(() => { fired = Date.now(); ac.abort(); }, 20);
    let opens = 0;
    __observeOpens(() => opens++);
    const skipped: Record<string, number> = {};
    await readRepoFiles(root, [], { signal: ac.signal, runner: runGit, now: Date.now(), timeoutMs: 10_000,
      skip: (r) => { skipped[r] = (skipped[r] ?? 0) + 1; } });
    __observeOpens(undefined);
    clearTimeout(timer);
    // the timer fired while the pass ran (not after it), and stopped it before its last file
    expect(fired).toBeGreaterThan(0);
    expect(opens).toBeLessThan(64);
    expect(skipped).toEqual({ budget: 1 });
  }, 30_000);

  test("session folders past the cap are counted (folders-capped), not dropped silently", async () => {
    const root = repoWith("r", {});
    const subs = Array.from({ length: 70 }, (_, i) => path.join(root, `s${String(i).padStart(2, "0")}`));
    for (const d of subs) mkdirSync(d);
    const f = await read(root, subs);
    expect(f.skipped).toEqual({ "folders-capped": 6 });
  });

  test.skipIf(!POSIX)("a FIFO where a repo file goes is no file: never opened, the read never hangs (POSIX)", async () => {
    const root = repoWith("r", {});
    mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
    mkdirSync(path.join(root, ".husky"));
    mkdirSync(path.join(root, ".claude"));
    for (const rel of ["CLAUDE.md", ".github/workflows/ci.yml", ".husky/pre-commit", ".claude/settings.json"]) {
      if (Bun.spawnSync(["mkfifo", path.join(root, rel)]).exitCode !== 0) throw new Error("mkfifo failed");
    }
    const opened: string[] = [];
    __observeOpens((p) => opened.push(p));
    const f = await read(root, [root]);
    __observeOpens(undefined);
    expect(opened).toEqual([]);
    expect([f.instructions.files, f.ci.present, f.precommit.present]).toEqual([[], false, false]);
    expect(f.skipped).toEqual({ "file-not-file": 4 });
  }, 30_000);
});

describe("the instruction-file history", () => {
  test.skipIf(!GIT_37)("HEAD's newest commit dated years back hides none of the recent instruction commits (git >= 2.37)", async () => {
    const root = makeRepo(path.join(h.root, "r"), [1, 2, 3].map((i) => ({ files: { "CLAUDE.md": `v${i}` }, message: `docs ${i}`, at: ago(10 - i) })));
    const date = new Date(Date.UTC(2015, 0, 1)).toISOString();
    git(root, ["-c", "user.email=dev@fixture.test", "-c", "user.name=Fixture Dev", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "skewed clock"],
      { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    const f = await read(root, [root]);
    expect(f.instructions.touched).toBe(3);
    // and through a scan, which passes the git version's choice itself
    const r = await run([root]);
    expect(r.repos.repos[0]!.instructions.touched).toBe(3);
  });
});

describe("repo files in a scan", () => {
  test("a linked worktree with the only instruction file, where the session ran: read from that worktree", async () => {
    const main = makeRepo(path.join(h.root, "main"), [{ files: { "a.txt": "a" }, message: "one", at: ago(4) }]);
    const wt = path.join(h.root, "wt");
    git(main, ["worktree", "add", "-q", "-b", "side", wt]);
    plant(wt, { "CLAUDE.md": "`bun test`", ".github/workflows/ci.yml": "jobs:\n  a:\n    steps:\n      - run: make lint\n" });
    const r = await run([wt]);
    expect(r.repos.repos).toHaveLength(1);
    expect(r.repos.repos[0]).toMatchObject({ instructions: { files: ["claude"], namesChecks: ["test"] }, ci: { present: true, checks: ["lint"] } });
  });

  test("several worktrees with sessions: the one with the most detail sessions is read", async () => {
    const main = makeRepo(path.join(h.root, "main"), [{ files: { "a.txt": "a" }, message: "one", at: ago(4) }]);
    const wt = path.join(h.root, "wt");
    git(main, ["worktree", "add", "-q", "-b", "side", wt]);
    plant(main, { "AGENTS.md": "x" });
    plant(wt, { "GEMINI.md": "x" });
    expect((await run([[main, 1], [wt, 3]])).repos.repos[0]!.instructions.files).toEqual(["gemini"]);
    expect((await run([[main, 3], [wt, 1]])).repos.repos[0]!.instructions.files).toEqual(["agents"]);
  });

  test("a repo without user.email still has its files read", async () => {
    const root = makeRepo(path.join(h.root, "r"), [{ files: { "CLAUDE.md": "`pytest`" }, message: "a", at: ago(3) }], { email: "" });
    // no global config either: every test here runs with a home of its own
    const r = await run([root]);
    expect(r.repos.repos[0]).toMatchObject({ identity: false, commits: [], instructions: { files: ["claude"], namesChecks: ["test"], touched: 1 } });
  });

  test("a throw in a repo's files pass keeps its commits; the error is counted", async () => {
    const root = repoWith("r", { "CLAUDE.md": "`pytest`" });
    const projectKey = "p1";
    let gets = 0;
    // the files pass looks the session folder up a second time (discovery is the first): that lookup throws
    const cwds = new (class extends Map<string, string> {
      override get(k: string) { if (++gets > 1) throw new Error("boom"); return super.get(k); }
    })([[projectKey, root]]);
    const r = await collectRepoSignals({ cwds, recent: new Set([projectKey]), salt: new Uint8Array(32), now: Date.now(), signal: new AbortController().signal });
    // the files pass did not finish: the pass is partial
    expect(r.status).toBe("partial");
    expect(r.repos).toHaveLength(1);
    expect(r.repos[0]!.commits).toHaveLength(1);
    expect(r.repos[0]!.instructions.files).toEqual([]);
    expect(r.skipped).toEqual({ "files-error": 1 });
  });

  test("a repo whose config names another folder as its worktree is skipped (root-mismatch), and nothing there is opened or run in", async () => {
    const elsewhere = path.join(h.root, "elsewhere");
    plant(elsewhere, { "CLAUDE.md": "`pytest`", ".claude/settings.json": JSON.stringify({ hooks: {} }) });
    const root = repoWith("r", {});
    git(root, ["config", "core.worktree", elsewhere]);
    const opened: string[] = [];
    __observeOpens((p) => opened.push(p));
    const cwds: string[] = [];
    const r = await run([root], { repoSignals: { runner: (a, o) => { cwds.push(o.cwd); return runGit(a, o); } } });
    __observeOpens(undefined);
    expect(r.repos.repos).toEqual([]);
    expect(r.repos.skipped).toEqual({ "root-mismatch": 1 });
    expect(r.repos.status).toBe("ok");
    const real = realpathSync.native(elsewhere);
    expect(opened.filter((p) => p.startsWith(elsewhere) || p.startsWith(real))).toEqual([]);
    expect(cwds.filter((c) => c.startsWith(elsewhere) || c.startsWith(real))).toEqual([]);
  });

  test("repoSignals: false reads no repo file", async () => {
    const root = repoWith("r", { "CLAUDE.md": "`pytest`" });
    const opened: string[] = [];
    __observeOpens((p) => opened.push(p));
    await run([root], { repoSignals: false });
    __observeOpens(undefined);
    expect(opened.filter((p) => p.startsWith(root))).toEqual([]);
  });
});

describe("--explain: what repo signals read", () => {
  test("REPO_SIGNALS_DESCRIBE.reads names every file and folder readRepoFiles opens or lists, and never settings.local.json", () => {
    const reads = REPO_SIGNALS_DESCRIBE.reads.join("\n");
    const named = [...Object.values(INSTRUCTION_FILES), ...REPO_FILES, ...REPO_FOLDERS.map((f) => f.dir)];
    expect(named.filter((p) => !reads.includes(p))).toEqual([]);
    // settings.local.json is named only as never opened (pre-flight P21)
    expect(reads.split(/(?<=\.) /).filter((sentence) => sentence.includes("settings.local.json"))).toEqual([expect.stringMatching(/never opened/)]);
    expect(reads).toMatch(/system-level git config/i);
  });
});
