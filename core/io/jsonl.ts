import { fileState } from "./fs";
import { noteOpen } from "./observe";
import { maybeYield } from "./yield";

export const MAX_LINE_BYTES = 33_554_432;

export interface GcPacerOptions {
  /** Bytes streamed between two looks at the RSS. */
  checkEvery: number;
  /** No collection while the RSS is at or below this: a small scan pays nothing. */
  minRss: number;
  /** The RSS growth over the baseline that a collection waits for. */
  slack: number;
}

/**
 * Collects garbage when the process has grown by more than `slack` since it last did. Parsed lines leave garbage faster
 * than the engine reclaims it on its own while the event store grows, so without help a long scan's peak RSS climbs
 * with the bytes it streams. Every `checkEvery` bytes reported, the pacer reads the RSS: above `minRss`, and more than
 * `slack` over the baseline, it runs `collect` and takes the RSS after it as the new baseline (the first look sets the
 * first baseline). Every look also lowers the baseline to the RSS it reads when that is lower, so after the RSS falls
 * (a scan's store released, pages returned) growth is measured from the low mark, never from a stale high one. A heap that holds steady is never collected, however much is streamed; one that grows is collected
 * about once per `slack` of growth, so a large live store costs no more collections than a small one.
 */
export class GcPacer {
  /** False: `add` does nothing (no look at the RSS, no collection). */
  enabled = true;
  private bytes = 0;
  private baseline: number | undefined;
  private count = 0;
  constructor(
    private readonly opts: GcPacerOptions,
    private readonly collect: () => void,
    private readonly rss: () => number = () => process.memoryUsage().rss,
  ) {}

  /** The collections run so far. */
  get collections(): number {
    return this.count;
  }

  add(n: number): void {
    if (!this.enabled) return;
    this.bytes += n;
    if (this.bytes < this.opts.checkEvery) return;
    this.bytes = 0;
    const now = this.rss();
    if (this.baseline === undefined) {
      this.baseline = now;
      return;
    }
    this.baseline = Math.min(this.baseline, now);
    if (now <= this.opts.minRss || now - this.baseline <= this.opts.slack) return;
    this.collect();
    this.count++;
    this.baseline = this.rss();
  }
}

const MiB = 1024 * 1024;
/** The pacer every JSONL stream reports to, process-wide (concurrent readers share one memory budget). */
export const STREAM_GC = new GcPacer({ checkEvery: 8 * MiB, minRss: 384 * MiB, slack: 128 * MiB }, () => Bun.gc(true));

/** The holds on STREAM_GC: every one held, and how many of them asked for `auto`. */
let holds = 0;
let autoHolds = 0;
/** STREAM_GC.enabled as it was when the first of the current holds was taken. */
let enabledBefore = true;

/**
 * Sets STREAM_GC for a scan and returns its release (idempotent). STREAM_GC is shared by every scan in the process, and
 * scans can overlap, so the holds are counted: while any hold is held, the pacer is on if any of them asked for `auto`,
 * and off only while every one of them asked for `off` (an auto scan's memory protection is never traded for another
 * scan's preference: a collection costs only CPU). Every take and release recomputes that from the holds still held, so
 * an off scan that joins or ends never turns the pacer off under a running auto scan, and once the last auto scan ends
 * the pacer is off for the off scans still running. The last release restores the state that was there before the first
 * hold; a value set by hand on `STREAM_GC.enabled` while a hold is held is overwritten at the next take or release.
 */
export function holdStreamGc(mode: "auto" | "off"): () => void {
  if (holds === 0) enabledBefore = STREAM_GC.enabled;
  holds++;
  if (mode === "auto") autoHolds++;
  STREAM_GC.enabled = autoHolds > 0;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
    if (mode === "auto") autoHolds--;
    STREAM_GC.enabled = holds === 0 ? enabledBefore : autoHolds > 0;
  };
}

export type JsonlItem =
  | { n: number; value: unknown }
  | { n: number; skip: "oversize" | "parse" | "sniffed"; bytes: number };

export interface JsonlOpts {
  sniffSkip?: (head: string) => boolean;
  headBytes?: number; // default 512
  maxLineBytes?: number; // default MAX_LINE_BYTES
  signal?: AbortSignal;
}

/**
 * Stream a JSONL file with bounded memory, links followed. Bad *content* never throws (malformed lines yield
 * `{skip:"parse"}`). Only a missing path (`fileState` `missing`) yields nothing; any other path that is not a regular
 * file (a folder, a device, a path that cannot be stat'ed: EACCES, ELOOP) and any I/O failure while reading throws, so
 * callers can record a coverage error; so does a never-opened file, refused unopened (`noteOpen`: NeverOpenedError).
 * Between chunks the stream lets the event loop run (`maybeYield`), so a signal or an abort is seen mid-file; once
 * `signal` is aborted it ends early, and the caller must not count the file as fully read.
 */
export async function* readJsonl(path: string, opts: JsonlOpts = {}): AsyncGenerator<JsonlItem> {
  const state = fileState(path);
  if (state === "missing") return;
  if (state !== "file") throw new Error(state === "error" ? "the path cannot be stat'ed" : `not a regular file (${state})`);
  noteOpen(path, "stream");
  yield* readJsonlStream(Bun.file(path).stream() as ReadableStream<Uint8Array>, opts);
}

export async function* readJsonlStream(
  stream: ReadableStream<Uint8Array>,
  opts: JsonlOpts = {},
): AsyncGenerator<JsonlItem> {
  const maxLine = opts.maxLineBytes ?? MAX_LINE_BYTES;
  const headBytes = opts.headBytes ?? 512;
  const decoder = new TextDecoder("utf-8");
  const reader = stream.getReader();

  let parts: Uint8Array[] = [];
  let carry = 0;
  let discarding = false;
  let n = 0;

  function* finish(tail: Uint8Array): Generator<JsonlItem> {
    n++;
    const line = parts.length === 0 ? tail : concat(parts, tail, carry + tail.length);
    parts = [];
    carry = 0;
    const bytes = line.length;
    if (opts.sniffSkip && bytes > 0 && opts.sniffSkip(decoder.decode(line.subarray(0, headBytes)))) {
      yield { n, skip: "sniffed", bytes };
      return;
    }
    let text = decoder.decode(line);
    if (text.endsWith("\r")) text = text.slice(0, -1);
    if (text.trim() === "") return;
    try {
      yield { n, value: JSON.parse(text) };
    } catch {
      yield { n, skip: "parse", bytes };
    }
  }

  try {
    for (;;) {
      const pause = maybeYield();
      if (pause) await pause;
      if (opts.signal?.aborted) return;
      const r = await reader.read();
      if (r.done) break;
      const chunk = r.value;
      STREAM_GC.add(chunk.length);
      let pos = 0;
      while (pos < chunk.length) {
        if (opts.signal?.aborted) return;
        const nl = chunk.indexOf(10, pos);
        const end = nl === -1 ? chunk.length : nl;
        const segLen = end - pos;
        if (discarding) {
          carry += segLen;
        } else if (carry + segLen > maxLine) {
          discarding = true;
          carry += segLen;
          parts = [];
        } else if (nl === -1) {
          parts.push(chunk.subarray(pos, end));
          carry += segLen;
        }
        if (nl === -1) break;
        // newline reached: finish line
        if (discarding) {
          n++;
          yield { n, skip: "oversize", bytes: carry };
          discarding = false;
          carry = 0;
        } else {
          yield* finish(chunk.subarray(pos, end));
        }
        pos = nl + 1;
      }
    }
    // final line without trailing newline
    if (discarding) {
      n++;
      yield { n, skip: "oversize", bytes: carry };
    } else if (carry > 0) {
      yield* finish(new Uint8Array(0));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

function concat(parts: Uint8Array[], tail: Uint8Array, total: number): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  out.set(tail, o);
  return out;
}
