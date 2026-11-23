import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync, type Stats } from "node:fs";
import path from "node:path";
import { NeverOpenedError, noteOpen } from "./observe";
import { maybeYield } from "./yield";

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

/**
 * What is at a path, links followed (a link is what it points to): a regular `file`, a `dir`, `other` (a device, a
 * pipe, a socket), `missing` (ENOENT or ENOTDIR: nothing there, a dangling link, a path through a file), or `error`
 * when the path cannot be stat'ed (EACCES, ELOOP, any other failure: something may be there).
 */
export type FileState = "file" | "dir" | "missing" | "other" | "error";

/** A path's FileState and, when something is there, its stats (links followed). */
export type PathStat = { state: "missing" | "error" } | { state: "file" | "dir" | "other"; stat: Stats };

/** Stats a path, links followed (see FileState). */
export function statPath(p: string): PathStat {
  let stat: Stats;
  try {
    stat = statSync(p);
  } catch (e) {
    const code = (e as { code?: string }).code;
    return { state: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "error" };
  }
  return { state: stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other", stat };
}

/** The FileState of a path (see `statPath`). */
export function fileState(p: string): FileState {
  return statPath(p).state;
}

/**
 * When the file or folder at a path came to be, by stat (links followed; nothing is opened): its birth time, else — on
 * a file system that records none — its ctime, in whole ms. Undefined when nothing is there or it cannot be stat'ed.
 */
export function bornAt(p: string): number | undefined {
  const s = statPath(p);
  if (!("stat" in s)) return undefined; // missing, or not stat-able
  const ms = s.stat.birthtimeMs > 0 ? s.stat.birthtimeMs : s.stat.ctimeMs;
  return ms > 0 ? Math.floor(ms) : undefined;
}

/**
 * Whether a path is a folder. The one policy for a path a reader names: a linked folder counts (the tools' folders are
 * often linked into place). Traversal (`walk`, `listDir`) never follows links.
 */
export const isDir = (p: string): boolean => fileState(p) === "dir";
/** Whether a path is a regular file, a linked one included (see `isDir`). */
export const isFile = (p: string): boolean => fileState(p) === "file";

export type JsonSmallResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "missing" | "not-file" | "too-large" | "io-error" | "parse" };

/**
 * Parse a small JSON file, saying why it could not be used (missing, not a regular file, too large, unreadable, invalid).
 * A never-opened file (`noteOpen`) is refused unopened, and reads as unreadable.
 */
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
    noteOpen(p, "read");
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

export type TextSmallResult = { ok: true; text: string } | { ok: false; reason: "missing" | "not-file" | "too-large" | "refused" | "io-error" };

/**
 * A small text file read whole (a repo's allowlisted files), links followed, saying why it could not be read: `missing`
 * (nothing there, a dangling link), `not-file` (a folder, a pipe, a device: never opened, so a FIFO cannot hang the
 * read), `too-large` (over `maxBytes`: never opened), `refused` (a never-opened file, by its name or its link's target:
 * attempted, never opened — `noteOpen`), `io-error`. The file is opened without blocking and checked again by its open
 * handle, so one swapped for a pipe or grown past the cap between the checks is still refused. A leading UTF-8 BOM is
 * dropped and invalid UTF-8 replaced.
 */
export function readTextSmall(p: string, maxBytes: number): TextSmallResult {
  const s = statPath(p);
  if (s.state === "missing") return { ok: false, reason: "missing" };
  if (s.state === "error") return { ok: false, reason: "io-error" };
  if (s.state !== "file") return { ok: false, reason: "not-file" };
  if (s.stat.size > maxBytes) return { ok: false, reason: "too-large" };
  try {
    noteOpen(p, "read");
  } catch (e) {
    return { ok: false, reason: e instanceof NeverOpenedError ? "refused" : "io-error" };
  }
  let fd: number;
  try {
    fd = openSync(p, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch {
    return { ok: false, reason: "io-error" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: "not-file" };
    if (st.size > maxBytes) return { ok: false, reason: "too-large" };
    const buf = new Uint8Array(maxBytes + 1);
    let size = 0;
    for (;;) {
      const n = readSync(fd, buf, size, buf.length - size, null);
      if (n === 0) break;
      size += n;
      if (size > maxBytes) return { ok: false, reason: "too-large" };
    }
    let bytes = buf.subarray(0, size);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
    return { ok: true, text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: "io-error" };
  } finally {
    closeSync(fd);
  }
}

/**
 * The lines of a text file, streamed with bounded memory, links followed: split at `\n` (a `\r` before it is kept), a
 * leading UTF-8 BOM dropped, invalid UTF-8 replaced; a last line without a newline is yielded unless it is empty.
 * `maxBytes` caps each line, never the file: a longer line ends the read with a RangeError. Between chunks the read lets
 * the event loop run (`maybeYield`); once `signal` is aborted it ends early, and the caller must not count the file as
 * fully read. Any I/O failure throws, a missing path included (callers stat the path first); so does a path that is not
 * a regular file (a folder, a pipe, a device: never opened, so a FIFO cannot hang the read), and a never-opened file,
 * refused unopened (`noteOpen`: NeverOpenedError).
 */
export async function* readTextLines(p: string, o: { maxBytes: number; signal?: AbortSignal }): AsyncGenerator<string> {
  const state = fileState(p);
  if (state === "missing") throw Object.assign(new Error("no such file"), { code: "ENOENT" });
  if (state !== "file") throw new Error(state === "error" ? "the path cannot be stat'ed" : `not a regular file (${state})`);
  noteOpen(p, "stream");
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let parts: Uint8Array[] = []; // pieces of the current line, joined once its newline arrives
  let carry = 0;
  let first = true;
  const take = (tail: Uint8Array): string => {
    let line = parts.length === 0 ? tail : Buffer.concat([...parts, tail]);
    parts = [];
    carry = 0;
    if (first) {
      first = false;
      if (line[0] === 0xef && line[1] === 0xbb && line[2] === 0xbf) line = line.subarray(3);
    }
    return decoder.decode(line);
  };
  for await (const chunk of Bun.file(p).stream()) {
    const pause = maybeYield();
    if (pause) await pause;
    if (o.signal?.aborted) return;
    for (let pos = 0; pos < chunk.length;) {
      const nl = chunk.indexOf(10, pos);
      const end = nl === -1 ? chunk.length : nl;
      if (carry + end - pos > o.maxBytes) throw new RangeError("line too long");
      if (nl === -1) {
        parts.push(chunk.subarray(pos));
        carry += end - pos;
        break;
      }
      yield take(chunk.subarray(pos, nl));
      pos = nl + 1;
    }
  }
  if (carry === 0) return;
  const last = take(new Uint8Array(0));
  if (last !== "") yield last;
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
