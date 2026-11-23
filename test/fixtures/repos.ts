// Synthetic git repositories for the repo-signal tests, built with the real `git` (present on every CI runner).
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface FixtureCommit {
  /** Files to write before the commit, by path relative to the repo: their content. */
  files: Record<string, string>;
  message: string;
  /** Author and committer time, epoch ms. */
  at: number;
  /** Author email; default the repo's `email`. */
  email?: string;
}

export const FIXTURE_EMAIL = "dev@fixture.test";

/** A global config file that does not exist: git reads none (so no hook or signing setting of the machine applies). */
const NO_GLOBAL = path.join(os.tmpdir(), "no-such-gitconfig-for-fixtures");

/** The environment a fixture's git runs in: no inherited GIT_* variable, no system or global config, no prompt. */
function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: NO_GLOBAL, GIT_TERMINAL_PROMPT: "0", ...extra };
}

/** Runs git in `cwd` and returns its trimmed stdout; throws with stderr when it fails. */
export function git(cwd: string, args: string[], extra: Record<string, string> = {}): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv(extra), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/**
 * A repository at `dir` (created), with `commits` made in order: each writes its files, stages everything and commits
 * with the given message, at its time (GIT_AUTHOR_DATE and GIT_COMMITTER_DATE), as its email, unsigned. `o.email` is the
 * repo's `user.email` (local config; default FIXTURE_EMAIL, `""` for none), and `o.config` more local config. Returns `dir`.
 */
export function makeRepo(dir: string, commits: FixtureCommit[], o: { email?: string; config?: Record<string, string> } = {}): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  const email = o.email ?? FIXTURE_EMAIL;
  if (email !== "") git(dir, ["config", "user.email", email]);
  git(dir, ["config", "user.name", "Fixture Dev"]);
  for (const c of commits) {
    for (const [rel, content] of Object.entries(c.files)) {
      const p = path.join(dir, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    git(dir, ["add", "-A"]);
    const date = new Date(c.at).toISOString();
    git(dir, ["-c", `user.email=${c.email ?? (email || FIXTURE_EMAIL)}`, "-c", "user.name=Fixture Dev", "-c", "commit.gpgsign=false",
      "commit", "-q", "--allow-empty", "-m", c.message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  }
  // config that takes effect only after the commits (a hostile repo's settings must not break building it)
  for (const [k, v] of Object.entries(o.config ?? {})) git(dir, ["config", k, v]);
  return dir;
}

/** The installed git's version as [major, minor]. */
export function gitVersion(): [number, number] {
  const m = /(\d+)\.(\d+)/.exec(git(process.cwd(), ["--version"]));
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}
