import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FONT_FILES, LICENSE_FILES } from "../../core/viz/fonts/manifest";
import { fetchFonts } from "../../scripts/fonts-fetch";

const DIR = path.join(import.meta.dir, "..", "..", "core", "viz", "fonts");
const ALL = [...FONT_FILES, ...LICENSE_FILES];

/** A fetch that serves each pinned URL from the committed file, `alter` applied to its bytes. */
const fakeFetch = (alter: (file: string, b: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (_, b) => b): typeof fetch =>
  (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const entry = ALL.find((e) => e.url === url);
    if (!entry) return new Response("not found", { status: 404 });
    return new Response(alter(entry.file, new Uint8Array(readFileSync(path.join(DIR, entry.file)))));
  }) as typeof fetch;

const temps: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(path.join(os.tmpdir(), "fonts-fetch-"));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("fetchFonts", () => {
  test("writes all 8 pinned files, byte for byte", async () => {
    const dir = tempDir();
    const { written } = await fetchFonts({ dir, fetch: fakeFetch() });
    expect(written.map((p) => path.basename(p)).sort()).toEqual(ALL.map((e) => e.file).sort());
    expect(readdirSync(dir).sort()).toEqual(ALL.map((e) => e.file).sort());
    for (const e of ALL) expect(Buffer.compare(readFileSync(path.join(dir, e.file)), readFileSync(path.join(DIR, e.file)))).toBe(0);
  });

  test("one flipped byte: it rejects and writes nothing", async () => {
    for (const target of [FONT_FILES[2]!.file, LICENSE_FILES[1]!.file]) {
      const dir = tempDir();
      const flip = (file: string, b: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => {
        if (file !== target) return b;
        const c = b.slice();
        c[100] = c[100]! ^ 0xff;
        return c;
      };
      await expect(fetchFonts({ dir, fetch: fakeFetch(flip) })).rejects.toThrow();
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  test("a failed download: it rejects and writes nothing", async () => {
    const dir = tempDir();
    const failing = (async () => new Response("gone", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchFonts({ dir, fetch: failing })).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});
