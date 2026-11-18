/** The signals a scan stops on: Ctrl-C, and the polite kill of `kill`, `timeout` and CI cancellation. */
export const TERM_SIGNALS = ["SIGINT", "SIGTERM"] as const;
export type TermSignal = (typeof TERM_SIGNALS)[number];

/**
 * Traps SIGINT and SIGTERM: while trapped, a delivered signal calls `on` instead of ending the process (its default
 * action). The handler only runs when the event loop gets a turn, so long work must yield (`maybeYield`). Returns the
 * function that releases the trap.
 */
export function trapSignals(on: (sig: TermSignal) => void): () => void {
  const listeners = TERM_SIGNALS.map((sig) => [sig, () => on(sig)] as const);
  for (const [sig, listener] of listeners) process.on(sig, listener);
  return () => {
    for (const [sig, listener] of listeners) process.removeListener(sig, listener);
  };
}

/**
 * Sends `sig` to this process again, once its trap is released: with no listener left, the signal's default action ends
 * the process — by that signal, so its exit status is non-zero — before this call returns. When the application has
 * listeners of its own, they receive it instead and the process goes on.
 */
export function reraise(sig: TermSignal): void {
  process.kill(process.pid, sig);
}
