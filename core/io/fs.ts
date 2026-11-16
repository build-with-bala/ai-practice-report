import { lstatSync, readdirSync, readFileSync, type Stats } from "node:fs";
import path from "node:path";

export function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function safeStat(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/** Parse a small JSON file; undefined when missing, too large, unreadable or invalid. */
export function readJsonSmall(p: string, maxBytes: number = 8 * 1024 * 1024): unknown | undefined {
  try {
    const st = lstatSync(p);
    if (!st.isFile() || st.size > maxBytes) return undefined;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Collect paths under `dir` accepted by `match`. Depth 0 = entries of `dir` itself.
 * Uses lstat and never follows symlinks (a symlink is an entry, not a directory).
 */
export function walk(
  dir: string,
  opts: { maxDepth: number; match: (name: string, isDir: boolean) => boolean },
): string[] {
  const out: string[] = [];
  const rec = (d: string, depth: number): void => {
    for (const name of safeList(d)) {
      const full = path.join(d, name);
      const st = safeStat(full);
      if (!st) continue;
      const isDir = st.isDirectory();
      if (opts.match(name, isDir)) out.push(full);
      if (isDir && depth < opts.maxDepth) rec(full, depth + 1);
    }
  };
  rec(dir, 0);
  return out;
}
