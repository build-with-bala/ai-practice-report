import { existsSync } from "node:fs";

export const MAX_LINE_BYTES = 33_554_432;

/**
 * Runs `collect` once per `step` bytes reported, while the process RSS is above `minRss` (a small scan pays nothing).
 * Parsed lines leave garbage faster than the engine reclaims it on its own while the event store grows: measured on a
 * full scan of several GiB of JSONL, peak RSS reached 0.9–1.1 GiB at any scan concurrency, and stayed at 0.6–0.7 GiB
 * with a full collection per 64 MiB streamed, for 1–3 s more.
 */
export class GcPacer {
  private bytes = 0;
  constructor(
    private readonly step: number,
    private readonly minRss: number,
    private readonly collect: () => void,
    private readonly rss: () => number = () => process.memoryUsage().rss,
  ) {}

  add(n: number): void {
    this.bytes += n;
    if (this.bytes < this.step) return;
    this.bytes = 0;
    if (this.rss() > this.minRss) this.collect();
  }
}

/** The pacer every JSONL stream reports to, process-wide (concurrent readers share one memory budget). */
export const STREAM_GC = new GcPacer(64 * 1024 * 1024, 384 * 1024 * 1024, () => Bun.gc(true));

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
 * Stream a JSONL file with bounded memory. Bad *content* never throws (malformed lines yield
 * `{skip:"parse"}`). A genuinely missing path yields nothing; any other I/O failure
 * (EACCES, EISDIR, mid-read errors) throws so callers can record a coverage error.
 */
export async function* readJsonl(path: string, opts: JsonlOpts = {}): AsyncGenerator<JsonlItem> {
  if (!existsSync(path)) return;
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
