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

export type JsonSmallResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "missing" | "not-file" | "too-large" | "io-error" | "parse" };

/** Parse a small JSON file, saying why it could not be used (missing, not a regular file, too large, unreadable, invalid). */
export function readJsonSmallResult(p: string, maxBytes: number = 8 * 1024 * 1024): JsonSmallResult {
  let size: number;
  try {
    const st = lstatSync(p);
    if (!st.isFile()) return { ok: false, reason: "not-file" };
    size = st.size;
  } catch (e) {
    return { ok: false, reason: (e as { code?: string }).code === "ENOENT" ? "missing" : "io-error" };
  }
  if (size > maxBytes) return { ok: false, reason: "too-large" };
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return { ok: false, reason: "io-error" };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "parse" };
  }
}

/** Parse a small JSON file; undefined when missing, too large, unreadable or invalid. */
export function readJsonSmall(p: string, maxBytes: number = 8 * 1024 * 1024): unknown | undefined {
  const r = readJsonSmallResult(p, maxBytes);
  return r.ok ? r.value : undefined;
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
