/*
 * The time windows of the signals catalogue and the scoring model (design §6.4, §6.5): one copy of each, shared by the
 * readers and the analysis.
 */

/** A prompt this long after its session's previous activity starts a new task (an episode). */
export const TASK_GAP_MS = 30 * 60_000;
/** A turn followed by an interrupt or a correction within this window did not succeed. */
export const CORRECTION_WINDOW_MS = 10 * 60_000;
/** Parallelism counts buckets of this length (on epoch time): the share of active buckets with ≥ 2 sessions doing agent work. */
export const BUCKET_MS = 10 * 60_000;
/** An edit episode followed by a commit or a PR within this window was delivered. */
export const DELIVERY_WINDOW_MS = 24 * 3_600_000;
/** Reverts and fix-ups on the same files within this window are rework. */
export const REWORK_WINDOW_MS = 72 * 3_600_000;
