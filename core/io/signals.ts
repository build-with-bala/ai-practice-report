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

/** A scan inside the process-wide signal trap (`enterScanTrap`). */
export interface ScanTrap {
  /** The signal that stopped this scan: one caught while it was inside the trap, or before it entered. */
  readonly caught: TermSignal | undefined;
  /**
   * Leaves the trap, once the scan has cleaned up. It first gives the event loop one turn, so that a signal that landed
   * during the scan's last synchronous work (a job's tail, its temp cleanup) is caught. Without a signal it resolves (the
   * last scan to leave removes the listeners). With one, the last scan to leave removes the listeners and raises the
   * signal again, which ends the process by it; the scans that left before it never resolve, so no caller's post-scan
   * code runs. (Only when the application's own listeners for the signal keep the process going do they all resolve,
   * with what they read.) Calling it again returns the same promise.
   */
  leave(): Promise<void>;
}

interface Member { readonly abort: () => void; readonly closeSync: () => void; caught?: TermSignal }

/** The trap every scan inside it shares: one SIGINT/SIGTERM listener pair, while at least one scan is inside. */
interface Shared {
  readonly members: Set<Member>;
  release: () => void;
  /** The first signal caught: it aborted every scan inside. */
  caught?: TermSignal;
  /** The scans that left after the signal, waiting for the last one's re-raise. */
  readonly waiting: (() => void)[];
}

let shared: Shared | undefined;

/** A scan's callback, best effort: one that throws never keeps the others from running. */
function attempt(f: () => void): void {
  try {
    f();
  } catch {
    /* best effort */
  }
}

function open(): Shared {
  const t: Shared = { members: new Set(), release: () => {}, waiting: [] };
  t.release = trapSignals((sig) => onSignal(t, sig));
  return t;
}

/** Removes the trap's listeners; a later scan installs a new pair. */
function close(t: Shared): void {
  t.release();
  if (shared === t) shared = undefined;
}

/**
 * Raises `sig` again with the trap closed. It returns only when the application has listeners of its own for it, so
 * that the process goes on: then the scans waiting for it go on too, with what they read.
 */
function end(t: Shared, sig: TermSignal): void {
  close(t);
  reraise(sig);
  for (const resolve of t.waiting.splice(0)) resolve();
}

/**
 * The first signal aborts every scan inside the trap. A second one, while any scan is still inside, does not wait for
 * the unwinding: every scan's temp files are removed synchronously, and the signal is raised again at once.
 */
function onSignal(t: Shared, sig: TermSignal): void {
  if (t.caught === undefined) {
    t.caught = sig;
    for (const m of t.members) {
      m.caught = sig;
      attempt(m.abort);
    }
    return;
  }
  for (const m of t.members) attempt(m.closeSync);
  end(t, sig);
}

/**
 * Enters the process-wide trap: one SIGINT/SIGTERM listener pair, installed by the first scan to enter and shared by
 * every scan that enters while it is installed. `abort` stops the scan (the first signal calls it); `closeSync` removes
 * its temp files synchronously (a second signal calls it, just before the process ends). A scan that enters after a
 * signal was caught is aborted at once: the process is about to end.
 */
export function enterScanTrap(o: { abort: () => void; closeSync: () => void }): ScanTrap {
  const t = (shared ??= open());
  const m: Member = { abort: o.abort, closeSync: o.closeSync };
  t.members.add(m);
  if (t.caught !== undefined) {
    m.caught = t.caught;
    attempt(m.abort);
  }
  let leaving: Promise<void> | undefined;
  const leave = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve)); // a signal that landed in synchronous work is dispatched here
    t.members.delete(m);
    if (shared !== t) return; // a second signal closed the trap, and the application kept the process going
    if (t.caught === undefined) {
      if (t.members.size === 0) close(t);
      return;
    }
    if (t.members.size > 0) return new Promise<void>((resolve) => t.waiting.push(resolve)); // the last scan re-raises
    end(t, t.caught);
  };
  return {
    get caught() {
      return m.caught;
    },
    leave: () => (leaving ??= leave()),
  };
}
