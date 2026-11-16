import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { readJsonl, readJsonlStream, type JsonlItem } from "../../../core/io/jsonl";

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
