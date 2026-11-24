import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, statSync, symlinkSync, utimesSync } from "node:fs";
import path from "node:path";
import { scan } from "../../../core/scan";
import { Tally } from "../../../core/sources/common/coverage";
import { streamJsonlFile, type StreamResult } from "../../../core/sources/common/stream";
import type { SourcePlugin } from "../../../core/sources/types";
import { fakeHome, type FakeHome } from "../../kit/home";

let h: FakeHome;
beforeEach(() => { h = fakeHome(); });
afterEach(() => h.cleanup());

const skipChmod = process.platform === "win32" || process.getuid?.() === 0;
const LINES = [{ n: 1 }, { n: 2 }, { n: 3 }];
const IO_LOG = "test.io-error";

/**
 * Streams `file` from a one-off plugin inside a scan: what the stream returned, the tally it counted into, and the codes
 * the scan's `onLog` received.
 */
async function run(file: string, onRecord: (v: unknown) => void | "stop" = () => {}, signal?: AbortSignal) {
  const tally = new Tally("codex", "test.stream");
  const logs: string[] = [];
  let res: StreamResult | undefined;
  const plugin: SourcePlugin = {
    tool: "codex", id: "test.stream", tier: "P0", beta: false, describe: { reads: [], neverReads: [] },
    locate: () => [{ root: h.env.home, home: h.env.home, wsl: false }],
    scan: async (_c, ctx) => {
      res = await streamJsonlFile(file, ctx, tally, onRecord, { ioLog: IO_LOG });
      ctx.emit(tally.coverage());
    },
  };
  await scan({ env: h.env, plugins: [plugin], signal, onLog: (_level, code) => logs.push(code) });
  if (res === undefined) throw new Error("the plugin did not run");
  return { res, tally, logs };
}

const counts = (t: Tally) => ({ files: t.files, bytes: t.bytes, records: t.records, skipped: t.skipped });

/** A link at `at` to the file `target`; false on Windows when the account may not create one (no symlink privilege). */
function linkFile(target: string, at: string): boolean {
  try {
    symlinkSync(target, at);
    return true;
  } catch (e) {
    if (process.platform !== "win32") throw e;
    return false;
  }
}

describe("streamJsonlFile", () => {
  test("a link to a regular file is read through the link: one file of the target's size, every record", async () => {
    const target = h.writeJsonl("dotfiles/history.jsonl", LINES);
    const at = path.join(h.env.home, ".tool", "history.jsonl");
    mkdirSync(path.dirname(at), { recursive: true });
    if (!linkFile(target, at)) return; // where no link can be made, there is nothing to read through
    const seen: unknown[] = [];
    const { res, tally } = await run(at, (v) => { seen.push(v); });
    const size = statSync(target).size;
    expect(seen).toEqual(LINES);
    expect(counts(tally)).toEqual({ files: 1, bytes: size, records: 3, skipped: {} });
    expect(res.read).toBe(true);
    expect(res.size).toBe(size);
    expect(res.stat?.isFile()).toBe(true);
  });

  test("a folder at the path counts not-file; a missing path counts nothing", async () => {
    const folder = path.join(h.env.home, "history.jsonl");
    mkdirSync(folder);
    const dir = await run(folder);
    expect(counts(dir.tally)).toEqual({ files: 0, bytes: 0, records: 0, skipped: { "not-file": 1 } });
    expect(dir.res.read).toBe(false);
    expect(dir.res.stat).toBeUndefined();
    const missing = await run(path.join(h.env.home, "nope.jsonl"));
    expect(counts(missing.tally)).toEqual({ files: 0, bytes: 0, records: 0, skipped: {} });
    expect(missing.res).toEqual({ read: false, size: 0 });
  });

  test("a record whose mapping throws counts bad-record, and the next one goes on", async () => {
    const file = h.writeJsonl("h.jsonl", LINES);
    const seen: unknown[] = [];
    const { res, tally } = await run(file, (v) => {
      if ((v as { n: number }).n === 2) throw new Error("mapping bug");
      seen.push(v);
    });
    expect(seen).toEqual([{ n: 1 }, { n: 3 }]);
    expect(counts(tally)).toEqual({ files: 1, bytes: statSync(file).size, records: 3, skipped: { "bad-record": 1 } });
    expect(res.read).toBe(true);
  });

  test("a file written to while it is read: its stat is taken once the read reached its end, so its times follow its last write", async () => {
    const file = h.writeJsonl("h.jsonl", LINES);
    const later = new Date(Math.floor(statSync(file).mtimeMs / 1000) * 1000 + 3_600_000); // whole seconds: every file system keeps them
    const { res, tally } = await run(file, (v) => {
      if ((v as { n: number }).n !== 1) return;
      appendFileSync(file, `${JSON.stringify({ n: 4 })}\n`);
      utimesSync(file, later, later);
    });
    expect(res.read).toBe(true);
    expect(res.stat!.mtimeMs).toBe(later.getTime());
    expect([res.size, tally.bytes]).toEqual([statSync(file).size, statSync(file).size]);
  });

  test('"stop" ends the file: it is not counted as read to its end', async () => {
    const file = h.writeJsonl("h.jsonl", LINES);
    const { res, tally } = await run(file, () => "stop");
    expect(counts(tally)).toEqual({ files: 0, bytes: 0, records: 1, skipped: {} });
    expect(res.read).toBe(false);
    expect(res.stat?.isFile()).toBe(true); // it was a regular file
  });

  test("an abort while the file is read: not counted as read to its end", async () => {
    const file = h.writeJsonl("h.jsonl", LINES);
    const ac = new AbortController();
    const { res, tally } = await run(file, () => ac.abort(), ac.signal);
    expect(res.read).toBe(false);
    expect(tally.files).toBe(0);
  });

  test.skipIf(skipChmod)("an unreadable file counts io-error, and the log code reaches onLog", async () => {
    const file = h.writeJsonl("h.jsonl", LINES);
    chmodSync(file, 0o000);
    try {
      const { res, tally, logs } = await run(file);
      expect(counts(tally)).toEqual({ files: 0, bytes: 0, records: 0, skipped: { "io-error": 1 } });
      expect(logs).toContain(IO_LOG);
      expect(res.read).toBe(false);
    } finally {
      chmodSync(file, 0o600);
    }
  });

  test.skipIf(skipChmod)("a file inside an unreadable folder is an io-error, not missing", async () => {
    const file = h.writeJsonl("locked/h.jsonl", LINES);
    const folder = path.dirname(file);
    chmodSync(folder, 0o000);
    try {
      const { res, tally, logs } = await run(file);
      expect(counts(tally)).toEqual({ files: 0, bytes: 0, records: 0, skipped: { "io-error": 1 } });
      expect(logs).toContain(IO_LOG);
      expect(res.read).toBe(false);
    } finally {
      chmodSync(folder, 0o700);
    }
  });
});
