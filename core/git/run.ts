/**
 * The one place core runs a program: git, read-only. Only `--version`, `rev-parse`, `config --get` and `log` are ever
 * passed (core/git's callers); each runs asynchronously with a timeout and an output cap, and stops on abort. git is
 * always started by an absolute path found on PATH (`resolveGit`), never from the working folder.
 */
import { accessSync, statSync } from "node:fs";
import path from "node:path";
import { STREAM_GC } from "../io/jsonl";

export interface GitResult { code: number | null; stdout: string; timedOut: boolean; truncated: boolean }
/**
 * `git`: the absolute path of the git to run (`resolveGit`); found on PATH when left out. `onChunk`: stdout is handed
 * over chunk by chunk as it arrives (up to `maxBytes` in all) and not kept, so `stdout` is empty; the chunk is valid only
 * during the call, and whatever the callee keeps it copies. A runner that does not stream may ignore it and return
 * `stdout`.
 */
export type GitRunner = (args: readonly string[], o: { cwd: string; timeoutMs: number; maxBytes: number; signal: AbortSignal; git?: string;
  onChunk?: (chunk: Uint8Array) => void }) => Promise<GitResult>;

/**
 * Put before every subcommand: no pager; and repo config that would run a program, take a lock or change the output is
 * overridden — no fsmonitor hook, no signature check (`log.showSignature` would run `gpg.program`), paths unquoted,
 * no colour, no transport, and log output in UTF-8 (`i18n.logOutputEncoding` set to UTF-16 would make every record
 * unreadable).
 */
export const GIT_SAFE_ARGS: readonly string[] = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "-c", "core.quotepath=off", "-c", "color.ui=never",
  "-c", "protocol.allow=never", "-c", "i18n.logOutputEncoding=UTF-8"];

/**
 * Set on every git child: no optional locks, no prompt, no lazy fetch of a partial clone, no transport at all (so even a
 * git too old to know GIT_NO_LAZY_FETCH cannot fetch through a remote — whose URL repo config may make an `ext::`
 * command or an ssh call; GIT_ALLOW_PROTOCOL outranks repo-level `protocol.*.allow`), no system config, no pager, C locale;
 * and on Windows no program found in the working folder by a bare name (`NoDefaultCurrentDirectoryInExePath`: what git
 * itself starts never comes from the repo).
 */
const SAFE_ENV: Readonly<Record<string, string>> = {
  GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "none", GIT_CONFIG_NOSYSTEM: "1", GIT_PAGER: "cat", LC_ALL: "C",
  NoDefaultCurrentDirectoryInExePath: "1",
};

/** A regular file this process may run (on Windows, any regular file: PATHEXT decides what runs). */
function runnable(p: string, win: boolean): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (!win) accessSync(p, 1); // X_OK
    return true;
  } catch {
    return false;
  }
}

/**
 * The absolute path of `git` on `env`'s PATH: the first absolute PATH entry holding it (relative entries, `.` among them,
 * are skipped, and the working folder is never looked in). On Windows only `git.exe` is run (when PATHEXT lists `.exe`),
 * never a `git.cmd`, which would run under cmd.exe: an install with only a `git.cmd` is git-missing. Undefined when
 * there is none.
 */
export function resolveGit(env: Record<string, string | undefined>, platform: string = process.platform): string | undefined {
  const win = platform === "win32";
  const p = win ? path.win32 : path.posix;
  const get = (name: string) => (win ? Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1] : env[name]);
  const listed = new Set((get("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim().toLowerCase()));
  const exts = win ? [".exe"].filter((e) => listed.has(e)) : [""];
  const dirs = (get("PATH") ?? "").split(win ? ";" : ":").map((raw) => raw.trim().replace(/^"(.*)"$/, "$1"))
    .filter((dir) => dir !== "" && p.isAbsolute(dir) && (!win || /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(dir)));
  for (const ext of exts) {
    for (const dir of dirs) {
      const exe = p.join(dir, `git${ext}`);
      if (runnable(exe, win)) return exe;
    }
  }
  return undefined;
}

/**
 * A git child's environment: `base` (the inherited one) without any `GIT_*` variable — so an inherited `GIT_DIR`,
 * `GIT_CONFIG_*` or `GIT_EXTERNAL_DIFF` steers nothing — and with SAFE_ENV set.
 */
export function gitEnv(base: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !/^GIT_/i.test(k)) out[k] = v;
  return { ...out, ...SAFE_ENV };
}

/** How long a killed child may take to be reaped before the result is returned anyway. */
const REAP_MS = 1_000;

/**
 * Runs `git <GIT_SAFE_ARGS> <args>` in `o.cwd`: stdin and stderr ignored, stdout streamed. The child is killed on
 * timeout (`timedOut`), on abort, and once stdout passes `maxBytes` (cut there: `truncated`). `code` is the exit code,
 * null when the child was killed. Rejects only when git cannot be started (ENOENT: no git, or no such folder), or when
 * `onChunk` throws (the child is killed first).
 *
 * Memory: each read of the child's stdout comes in a freshly allocated backing buffer much larger than the chunk (a
 * small chunk can pin a buffer many times its size), so no chunk is ever kept — with `onChunk` each goes to the callee,
 * without it its bytes are copied — and each read is reported to the streaming pacer (STREAM_GC) by the size of its
 * backing buffer, what it really allocated, so collections keep pace with git output as they do with file streams.
 */
export const runGit: GitRunner = (args, o) => run(args, o, gitEnv(process.env));

async function run(args: readonly string[], o: Parameters<GitRunner>[1], env: Record<string, string>): Promise<GitResult> {
  if (o.signal.aborted) return { code: null, stdout: "", timedOut: false, truncated: false };
  const exe = o.git ?? resolveGit(process.env);
  if (exe === undefined || !path.isAbsolute(exe)) throw Object.assign(new Error("git not found"), { code: "ENOENT" });
  const child = Bun.spawn([exe, ...GIT_SAFE_ARGS, ...args], {
    cwd: o.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore",
  });
  let timedOut = false;
  let truncated = false;
  let stopped = false;
  let wake: () => void = () => {};
  const stoppedP = new Promise<void>((resolve) => { wake = resolve; });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    wake();
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(0, o.timeoutMs));
  const onAbort = () => stop();
  o.signal.addEventListener("abort", onAbort, { once: true });

  const chunks: Uint8Array[] = [];
  let size = 0;
  let failed: { error: unknown } | undefined; // what `onChunk` threw
  /** One chunk's bytes: to the callee, or copied (never the view itself, which pins its backing buffer). */
  const accept = (bytes: Uint8Array): boolean => {
    if (!o.onChunk) {
      chunks.push(bytes.slice());
      return true;
    }
    try {
      o.onChunk(bytes);
      return true;
    } catch (error) {
      failed = { error };
      stop();
      return false;
    }
  };
  const reader = child.stdout.getReader();
  const reading = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped) break;
        // counted by the backing buffer: this assumes the runtime gives each read a buffer of its own (the current
        // one does, 256 KiB at the time of writing). Were the buffer a shared pool, its size would overstate the read,
        // which only brings collections sooner, never later
        STREAM_GC.add(Math.max(value.byteLength, value.buffer.byteLength));
        const room = o.maxBytes - size;
        if (value.byteLength > room) {
          if (room > 0) accept(value.subarray(0, room));
          size = o.maxBytes;
          truncated = true;
          stop();
          break;
        }
        size += value.byteLength;
        if (!accept(value)) break;
      }
    } catch { /* the stream ends with the child */ }
  })();
  // a killed child's stream may stay open (a grandchild holding it): once stopped, the result does not wait for it
  await Promise.race([Promise.all([reading, child.exited]), stoppedP]);
  clearTimeout(timer);
  o.signal.removeEventListener("abort", onAbort);
  if (stopped) {
    reader.cancel().catch(() => {});
    let reap: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([child.exited, new Promise((resolve) => { reap = setTimeout(resolve, REAP_MS); })]);
    clearTimeout(reap);
  }
  if (failed) throw failed.error;
  const bytes = new Uint8Array(o.onChunk ? 0 : size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return { code: stopped ? null : child.exitCode, stdout: new TextDecoder().decode(bytes), timedOut, truncated };
}
