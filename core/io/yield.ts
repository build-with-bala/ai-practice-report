/** The longest stretch of work between two turns of the event loop, in ms. */
export const SLICE_MS = 25;

let sliceStart = performance.now();

/**
 * A turn of the event loop once SLICE_MS of work has passed since the last one: timers, I/O callbacks and signal
 * handlers (SIGINT, SIGTERM, an abort wired to them) run there, so a long scan stays interruptible. Within the slice it
 * returns undefined and costs nothing; otherwise await the promise it returns (one `setImmediate`). The slice is
 * process-wide: readers that run at once share it.
 *
 *   const pause = maybeYield();
 *   if (pause) await pause;
 */
export function maybeYield(): Promise<void> | undefined {
  if (performance.now() - sliceStart < SLICE_MS) return undefined;
  return new Promise<void>((resolve) => {
    setImmediate(() => {
      sliceStart = performance.now();
      resolve();
    });
  });
}
