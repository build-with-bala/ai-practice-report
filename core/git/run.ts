/**
 * The one place core runs a program: git, read-only. Only `--version`, `rev-parse`, `config --get` and `log` are ever
 * passed (core/git's callers); each runs asynchronously with a timeout and an output cap, and stops on abort.
 */

export interface GitResult { code: number | null; stdout: string; timedOut: boolean; truncated: boolean }
export type GitRunner = (args: readonly string[], o: { cwd: string; timeoutMs: number; maxBytes: number; signal: AbortSignal }) => Promise<GitResult>;

/**
 * Put before every subcommand: no pager; and repo config that would run a program, take a lock or change the output is
 * overridden — no fsmonitor hook, no signature check (`log.showSignature` would run `gpg.program`), paths unquoted,
 * no colour.
 */
export const GIT_SAFE_ARGS: readonly string[] = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false", "-c", "core.quotepath=off", "-c", "color.ui=never"];

/** Set on every git child: no optional locks, no prompt, no lazy fetch of a partial clone, no system config, no pager, C locale. */
const SAFE_ENV: Readonly<Record<string, string>> = {
  GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_PAGER: "cat", LC_ALL: "C",
};

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
 * null when the child was killed. Rejects only when git cannot be started (ENOENT: no git, or no such folder).
 */
export const runGit: GitRunner = async (args, o) => {
  if (o.signal.aborted) return { code: null, stdout: "", timedOut: false, truncated: false };
  const child = Bun.spawn(["git", ...GIT_SAFE_ARGS, ...args], {
    cwd: o.cwd, env: gitEnv(process.env), stdin: "ignore", stdout: "pipe", stderr: "ignore",
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
  const reader = child.stdout.getReader();
  const reading = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped) break;
        const room = o.maxBytes - size;
        if (value.byteLength > room) {
          if (room > 0) chunks.push(value.subarray(0, room));
          size = o.maxBytes;
          truncated = true;
          stop();
          break;
        }
        chunks.push(value);
        size += value.byteLength;
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
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return { code: stopped ? null : child.exitCode, stdout: new TextDecoder().decode(bytes), timedOut, truncated };
};
