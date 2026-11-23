import path from "node:path";
import { fileState, isDir } from "../io/fs";
import { keyedHash, normalizePath } from "../text/hash";

/** How many ancestors of a session folder are checked for `.git` (the folder itself included). */
export const MAX_ANCESTORS = 20;

/**
 * The folder holding the nearest `.git` (a folder, or a file: a worktree or submodule) at or above `dir`, checked by
 * stat only, at most MAX_ANCESTORS levels up to the file-system root; undefined when there is none.
 */
export function gitAncestor(dir: string): string | undefined {
  let at = path.resolve(dir);
  for (let i = 0; i <= MAX_ANCESTORS; i++) {
    const state = fileState(path.join(at, ".git"));
    if (state === "dir" || state === "file") return at;
    const up = path.dirname(at);
    if (up === at) return undefined;
    at = up;
  }
  return undefined;
}

/** A session folder that may sit in a repo: the folder holding its nearest `.git`, and the projects found there. */
export interface Candidate { dir: string; projectKeys: string[] }

/**
 * The repo candidates of the recent session projects, never by crawling: each recent project's raw folder, when it is
 * a folder, and its nearest `.git` ancestor. Projects whose folder is gone count as `missing`, those with no `.git`
 * above them as `not-a-repo`; neither runs anything.
 */
export function candidates(cwds: ReadonlyMap<string, string>, recent: ReadonlySet<string>, skip: (reason: string) => void): Candidate[] {
  const byDir = new Map<string, string[]>();
  for (const key of recent) {
    const raw = cwds.get(key);
    if (raw === undefined) continue;
    if (!isDir(raw)) {
      skip("missing");
      continue;
    }
    const dir = gitAncestor(raw);
    if (dir === undefined) {
      skip("not-a-repo");
      continue;
    }
    const keys = byDir.get(dir);
    if (keys) keys.push(key);
    else byDir.set(dir, [key]);
  }
  return [...byDir].map(([dir, projectKeys]) => ({ dir, projectKeys }));
}

/** A repo: its key, its raw root (memory only), its session projects, and its detail-window session count. */
export interface Repo { repoKey: string; root: string; projectKeys: string[]; sessions: number }

/**
 * Groups candidates by the root `git rev-parse --show-toplevel` gave each (`tops`, by candidate dir), and keeps the
 * `max` repos with the most detail-window sessions (ties by key); the rest count as `too-many-repos`.
 */
export function groupRepos(found: { cand: Candidate; root: string }[], salt: Uint8Array, detailSessions: ReadonlyMap<string, number>,
  max: number, skip: (reason: string) => void): Repo[] {
  const byKey = new Map<string, Repo>();
  for (const { cand, root } of found) {
    const repoKey = keyedHash(salt, normalizePath(root));
    const repo = byKey.get(repoKey) ?? { repoKey, root, projectKeys: [], sessions: 0 };
    for (const k of cand.projectKeys) {
      if (repo.projectKeys.includes(k)) continue;
      repo.projectKeys.push(k);
      repo.sessions += detailSessions.get(k) ?? 0;
    }
    byKey.set(repoKey, repo);
  }
  const repos = [...byKey.values()].sort((a, b) => b.sessions - a.sessions || (a.repoKey < b.repoKey ? -1 : a.repoKey > b.repoKey ? 1 : 0));
  for (const r of repos) r.projectKeys.sort();
  for (let i = max; i < repos.length; i++) skip("too-many-repos");
  return repos.slice(0, Math.max(0, max));
}
