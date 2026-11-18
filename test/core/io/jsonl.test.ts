import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { GcPacer, readJsonl, readJsonlStream, STREAM_GC, type JsonlItem } from "../../../core/io/jsonl";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "jsonl-test-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function collect(file: string, opts?: Parameters<typeof readJsonl>[1]): Promise<JsonlItem[]> {
  const out: JsonlItem[] = [];
  for await (const it of readJsonl(file, opts)) out.push(it);
  return out;
}
function put(name: string, content: string): string {
  const p = path.join(dir, name);
  writeFileSync(p, content);
  return p;
}

describe("readJsonl", () => {
  test("CRLF, blank lines, no trailing newline; n counts physical lines", async () => {
    const items = await collect(put("a.jsonl", '{"a":1}\r\n\n{"a":2}\n{"a":3}'));
    expect(items.map((i) => ("value" in i ? i.value : null))).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(items.map((i) => i.n)).toEqual([1, 3, 4]);
  });
  test("parse failures are skipped, not thrown", async () => {
    const items = await collect(put("b.jsonl", '{"a":1}\n{bad\n{"a":2}\n'));
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ n: 1, value: { a: 1 } });
    expect(items[1]).toMatchObject({ n: 2, skip: "parse" });
    expect(items[2]).toMatchObject({ n: 3, value: { a: 2 } });
  });
  test("oversize line", async () => {
    const big = "x".repeat(2000);
    const items = await collect(put("c.jsonl", `{"a":1}\n${big}\n{"a":2}\n`), { maxLineBytes: 1024 });
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ value: { a: 1 } });
    expect(items[1]).toEqual({ n: 2, skip: "oversize", bytes: 2000 });
    expect(items[2]).toMatchObject({ n: 3, value: { a: 2 } });
  });
  test("oversize unterminated last line", async () => {
    const items = await collect(put("c2.jsonl", `{"a":1}\n${"x".repeat(3000)}`), { maxLineBytes: 1024 });
    expect(items[1]).toEqual({ n: 2, skip: "oversize", bytes: 3000 });
  });
  test("sniffSkip", async () => {
    const p = put("d.jsonl", '{"a":1}\n{"type":"api-request-blob","x":"' + "y".repeat(5000) + '"}\n{"a":2}\n');
    const items = await collect(p, { sniffSkip: (h) => h.includes('"type":"api-request-blob"') });
    expect(items).toHaveLength(3);
    expect(items[1]).toMatchObject({ n: 2, skip: "sniffed" });
    expect(items[2]).toMatchObject({ value: { a: 2 } });
  });
  test("multibyte UTF-8 split across chunks", async () => {
    const line = JSON.stringify({ s: "héllo→世界😀" }) + "\n";
    const bytes = new TextEncoder().encode(line + line);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
        c.close();
      },
    });
    const out: JsonlItem[] = [];
    for await (const it of readJsonlStream(stream)) out.push(it);
    expect(out.map((i) => ("value" in i ? i.value : null))).toEqual([{ s: "héllo→世界😀" }, { s: "héllo→世界😀" }]);
  });
  test("abort signal stops iteration", async () => {
    const ac = new AbortController();
    const p = put("e.jsonl", '{"a":1}\n{"a":2}\n{"a":3}\n');
    const out: JsonlItem[] = [];
    for await (const it of readJsonl(p, { signal: ac.signal })) {
      out.push(it);
      ac.abort();
    }
    expect(out.length).toBeLessThan(3);
  });
  test("missing file yields nothing", async () => {
    expect(await collect(path.join(dir, "nope.jsonl"))).toEqual([]);
  });
  test("directory path throws", async () => {
    await expect(collect(dir)).rejects.toThrow();
  });
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("unreadable file throws", async () => {
    const p = put("locked.jsonl", '{"a":1}\n');
    chmodSync(p, 0o000);
    try {
      await expect(collect(p)).rejects.toThrow();
    } finally {
      chmodSync(p, 0o600);
    }
  });
  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a file inside an unreadable folder throws: it is not missing", async () => {
    const locked = path.join(dir, "locked-dir");
    mkdirSync(locked);
    const p = path.join(locked, "x.jsonl");
    writeFileSync(p, '{"a":1}\n');
    chmodSync(locked, 0o000);
    try {
      await expect(collect(p)).rejects.toThrow();
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  describe("splitter is chunk-size independent", () => {
    const fixture =
      '{"a":1}\r\n' + // CRLF
      "\n" + // blank
      '{"s":"héllo→世界😀"}\n' + // multibyte
      "X".repeat(150) + "\n" + // oversize when max=100
      '{"type":"blob","pad":"' + "p".repeat(20) + '"}\n' + // sniffed
      "{bad\n" + // parse
      "Y".repeat(120) + "\n" + // oversize
      '{"z":9}\r\n' +
      '{"last":true}'; // unterminated
    const bytes = new TextEncoder().encode(fixture);
    const run = async (size: number, max?: number) => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
          c.close();
        },
      });
      const out: JsonlItem[] = [];
      for await (const it of readJsonlStream(stream, { maxLineBytes: max, sniffSkip: (h) => h.includes('"type":"blob"') }))
        out.push(it);
      return out;
    };
    // sizes chosen so some chunk edge lands exactly on a newline / the end of an oversize line
    const sizes = [1, 2, 3, 5, 7, 13, 64, 151, 152, bytes.length];
    for (const max of [undefined, 100]) {
      test(`max=${max ?? "default"}`, async () => {
        const expected = await run(bytes.length, max);
        for (const size of sizes) expect(await run(size, max)).toEqual(expected);
        const ns = expected.map((i) => i.n);
        expect(ns).toEqual(max === undefined ? [1, 3, 4, 5, 6, 7, 8, 9] : [1, 3, 4, 5, 6, 7, 8, 9]);
        const kinds = expected.map((i) => ("skip" in i ? i.skip : "ok"));
        expect(kinds).toEqual(
          max === undefined
            ? ["ok", "ok", "parse", "sniffed", "parse", "parse", "ok", "ok"]
            : ["ok", "ok", "oversize", "sniffed", "parse", "oversize", "ok", "ok"],
        );
      });
    }
  });

  test("bounded memory on a large file", async () => {
    const mib = process.env.SLOW === "1" ? 600 : 64;
    const p = path.join(dir, "big.jsonl");
    const line = JSON.stringify({ k: "v".repeat(270) }) + "\n"; // ~ 300 bytes
    const total = mib * 1024 * 1024;
    const ws = createWriteStream(p);
    const block = line.repeat(1000);
    for (let w = 0; w < total; w += block.length) {
      if (!ws.write(block)) await once(ws, "drain");
    }
    ws.end();
    await once(ws, "finish");

    Bun.gc(true);
    const base = process.memoryUsage().rss;
    let max = 0;
    let count = 0;
    for await (const it of readJsonl(p)) {
      if (!("value" in it)) throw new Error("unexpected skip");
      if (++count % 20000 === 0) max = Math.max(max, process.memoryUsage().rss - base);
    }
    max = Math.max(max, process.memoryUsage().rss - base);
    expect(count).toBeGreaterThan(100000);
    expect(max).toBeLessThan(128 * 1024 * 1024);
    rmSync(p, { force: true });
  }, 120_000);
});

describe("GcPacer", () => {
  test("collects once per step of bytes, and only while RSS is above its floor", () => {
    let rss = 60;
    let collections = 0;
    const pacer = new GcPacer(100, 50, () => collections++, () => rss);
    pacer.add(99);
    expect(collections).toBe(0);
    pacer.add(1); // the step is reached
    expect(collections).toBe(1);
    pacer.add(250); // one collection however far past the step, and the count starts again
    expect(collections).toBe(2);
    pacer.add(99);
    expect(collections).toBe(2);
    rss = 40; // below the floor: the step passes without a collection
    pacer.add(1);
    expect(collections).toBe(2);
    rss = 60;
    pacer.add(100);
    expect(collections).toBe(3);
  });

  test("readJsonl reports every byte it streams to the process-wide pacer", async () => {
    const p = put("paced.jsonl", `${'{"a":1}\n'.repeat(5000)}{"tail":true}`);
    let streamed = 0;
    const add = STREAM_GC.add;
    STREAM_GC.add = (n: number) => { streamed += n; };
    try {
      expect(await collect(p)).toHaveLength(5001);
    } finally {
      STREAM_GC.add = add;
    }
    expect(streamed).toBe(Bun.file(p).size);
  });
});
