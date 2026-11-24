import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileState, isDir } from "../io/fs";
import { keyedHash, normalizePath } from "../text/hash";

/** How many ancestors of a session folder are checked for `.git`, besides the folder itself (21 folders at most). */
export const MAX_ANCESTORS = 20;

/**
 * The folder holding the nearest `.git` (a folder, or a file: a worktree or submodule) at or above `dir`, checked by
 * stat only, at most MAX_ANCESTORS levels up to the file-system root; undefined when there is none. A `.git` file is
 * taken as git takes it: one that names another repository's git folder (its back-pointer is not checked) makes that
 * repository's history read under this folder.
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
 * a folder, and its nearest `.git` ancestor. Projects whose folder is not absolute count as `not-absolute`, those whose
 * folder is gone as `missing`, those with no `.git` above them as `not-a-repo`; none of them runs anything.
 */
export function candidates(cwds: ReadonlyMap<string, string>, recent: ReadonlySet<string>, skip: (reason: string) => void): Candidate[] {
  const byDir = new Map<string, string[]>();
  for (const key of recent) {
    const raw = cwds.get(key);
    if (raw === undefined) continue;
    // a folder named relatively would be resolved against this process's folder, which no session ran in
    if (!path.isAbsolute(raw)) {
      skip("not-absolute");
      continue;
    }
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

/** A worktree of a repo that sessions ran in: its root as git spells it (memory only), its session projects, and their detail-window sessions. */
export interface Worktree { root: string; projectKeys: string[]; sessions: number }

/**
 * A repo: its key, its raw root (memory only), its session projects, and its detail-window session count. `trees`: the
 * worktrees sessions ran in, the one with the most detail-window sessions first (then the smallest root) — where the
 * repo's files are read, since linked worktrees hold different files, and the common dir's parent may be no worktree.
 */
export interface Repo { repoKey: string; root: string; projectKeys: string[]; sessions: number; trees: Worktree[] }

/** What `git rev-parse --show-toplevel --git-common-dir` said for a candidate: its worktree root and the repo's common dir. */
export interface Found { cand: Candidate; root: string; commonDir: string }

/** A path with its links resolved, when it can be; as given otherwise. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Which folder a path is, whatever its spelling (links, case, Windows short names): its device and file id, when the
 * file system gives one; its normalized real path otherwise.
 */
function identity(p: string): string {
  try {
    const st = statSync(p, { bigint: true });
    if (st.ino !== 0n) return `${st.dev}:${st.ino}`;
  } catch { /* fall through */ }
  return normalizePath(p);
}

/** Whether two paths name the same folder, whatever their spelling (`identity`). */
export const sameFolder = (a: string, b: string): boolean => identity(a) === identity(b);

/**
 * The repo of each rev-parse answer: the linked worktrees of one repo share its common dir (resolved against the
 * candidate's folder, and compared by file identity), so they are one repo — whose root is the main worktree (the common
 * dir's parent, when the common dir is a `.git` folder), else the smallest worktree root. Projects are pooled per repo, and the `max`
 * repos with the most detail-window sessions kept (ties by key); the rest count as `too-many-repos`.
 */
export function groupRepos(found: readonly Found[], salt: Uint8Array, detailSessions: ReadonlyMap<string, number>,
  max: number, skip: (reason: string) => void): Repo[] {
  const byCommon = new Map<string, { common: string; roots: string[]; projectKeys: Set<string>; trees: Map<string, Set<string>> }>();
  for (const { cand, root, commonDir } of found) {
    const common = real(path.resolve(cand.dir, commonDir));
    const id = identity(common);
    const g = byCommon.get(id) ?? { common, roots: [], projectKeys: new Set<string>(), trees: new Map<string, Set<string>>() };
    g.roots.push(root);
    const tree = g.trees.get(root) ?? new Set<string>();
    for (const k of cand.projectKeys) {
      g.projectKeys.add(k);
      tree.add(k);
    }
    g.trees.set(root, tree);
    byCommon.set(id, g);
  }
  const sessionsOf = (keys: Iterable<string>): number => { let n = 0; for (const k of keys) n += detailSessions.get(k) ?? 0; return n; };
  const byKey = new Map<string, Repo>();
  for (const g of byCommon.values()) {
    // the main worktree, as git spells it when a session sat in it; else the common dir's parent; else (a bare or
    // submodule common dir) the smallest worktree root
    const roots = [...new Set(g.roots)].sort();
    let root = roots[0]!;
    if (path.basename(g.common) === ".git") {
      const main = identity(path.dirname(g.common));
      root = roots.find((r) => identity(r) === main) ?? path.dirname(g.common);
    }
    const repoKey = keyedHash(salt, normalizePath(root));
    const repo = byKey.get(repoKey) ?? { repoKey, root, projectKeys: [], sessions: 0, trees: [] };
    for (const k of g.projectKeys) {
      if (repo.projectKeys.includes(k)) continue;
      repo.projectKeys.push(k);
      repo.sessions += detailSessions.get(k) ?? 0;
    }
    for (const [treeRoot, keys] of g.trees) {
      const tree = repo.trees.find((t) => t.root === treeRoot);
      const merged = new Set([...(tree?.projectKeys ?? []), ...keys]);
      const next = { root: treeRoot, projectKeys: [...merged].sort(), sessions: sessionsOf(merged) };
      if (tree) Object.assign(tree, next);
      else repo.trees.push(next);
    }
    repo.trees.sort((a, b) => b.sessions - a.sessions || (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
    byKey.set(repoKey, repo);
  }
  const repos = [...byKey.values()].sort((a, b) => b.sessions - a.sessions || (a.repoKey < b.repoKey ? -1 : a.repoKey > b.repoKey ? 1 : 0));
  for (const r of repos) r.projectKeys.sort();
  for (let i = max; i < repos.length; i++) skip("too-many-repos");
  return repos.slice(0, Math.max(0, max));
}
