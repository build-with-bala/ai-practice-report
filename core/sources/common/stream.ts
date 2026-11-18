import type { Stats } from "node:fs";
import { statPath } from "../../io/fs";
import { readJsonl } from "../../io/jsonl";
import type { ScanCtx } from "../types";
import type { Tally } from "./coverage";

/** `read`: the file was read to its end. `size` and `stat` are the file's (link followed) when the path was a regular file. */
export interface StreamResult { read: boolean; size: number; stat?: Stats }

/**
 * Streams one JSONL file into `onRecord`, counting what it reads in `tally` — the read loop every JSONL reader shares.
 * - Nothing at the path (`missing`) counts nothing. A link to a regular file is read through the link; a path that is
 *   anything else counts `not-file`.
 * - A line the stream skips counts its reason (`parse`, `oversize`, `sniffed`). Each record counts toward `records`,
 *   then goes to `onRecord`: a throw counts `bad-record` and the next record goes on; returning `"stop"` ends the file.
 * - An I/O failure (a path that cannot be stat'ed, a read that fails) counts `io-error` and logs warn `o.ioLog`.
 * - Read to its end — not stopped, the scan not aborted — the file counts as one file of its size (`files`, `bytes`).
 */
export async function streamJsonlFile(file: string, ctx: ScanCtx, tally: Tally, onRecord: (v: unknown) => void | "stop",
  o: { sniffSkip?: (head: string) => boolean; ioLog?: string } = {}): Promise<StreamResult> {
  const ioError = (): void => {
    tally.skip("io-error");
    if (o.ioLog !== undefined) ctx.log("warn", o.ioLog);
  };
  const st = statPath(file);
  if (st.state === "missing") return { read: false, size: 0 };
  if (st.state === "error") {
    ioError();
    return { read: false, size: 0 };
  }
  if (st.state !== "file") {
    tally.skip("not-file");
    return { read: false, size: 0 };
  }
  const { stat } = st;
  const size = stat.size;
  let stopped = false;
  try {
    for await (const item of readJsonl(file, { sniffSkip: o.sniffSkip, signal: ctx.signal })) {
      if ("skip" in item) {
        tally.skip(item.skip);
        continue;
      }
      tally.records++;
      let next: void | "stop";
      try {
        next = onRecord(item.value);
      } catch {
        tally.skip("bad-record");
        continue;
      }
      if (next === "stop") {
        stopped = true;
        break;
      }
    }
  } catch {
    ioError();
    return { read: false, size, stat };
  }
  if (stopped || ctx.signal.aborted) return { read: false, size, stat };
  tally.files++;
  tally.bytes += size;
  return { read: true, size, stat };
}
