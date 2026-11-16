export const MAX_LINE_BYTES = 33_554_432;

export type JsonlItem =
  | { n: number; value: unknown }
  | { n: number; skip: "oversize" | "parse" | "sniffed"; bytes: number };

export interface JsonlOpts {
  sniffSkip?: (head: string) => boolean;
  headBytes?: number; // default 512
  maxLineBytes?: number; // default MAX_LINE_BYTES
  signal?: AbortSignal;
}

/** Stream a JSONL file with bounded memory. Never throws on bad input; a missing file yields nothing. */
export async function* readJsonl(path: string, opts: JsonlOpts = {}): AsyncGenerator<JsonlItem> {
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = Bun.file(path).stream() as ReadableStream<Uint8Array>;
  } catch {
    return;
  }
  yield* readJsonlStream(stream, opts);
}

export async function* readJsonlStream(
  stream: ReadableStream<Uint8Array>,
  opts: JsonlOpts = {},
): AsyncGenerator<JsonlItem> {
  const maxLine = opts.maxLineBytes ?? MAX_LINE_BYTES;
  const headBytes = opts.headBytes ?? 512;
  const decoder = new TextDecoder("utf-8");
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader(); // Bun.file(...).stream() reports ENOENT here
  } catch {
    return;
  }

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
      let chunk: Uint8Array;
      try {
        const r = await reader.read();
        if (r.done) break;
        chunk = r.value;
      } catch {
        return; // unreadable file / mid-read error: stop quietly
      }
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
