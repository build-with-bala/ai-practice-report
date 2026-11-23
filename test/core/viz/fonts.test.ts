import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { readAsset } from "../../../core/io/asset";
import { coveredBy, fontFaceCss, fontLicenses, uncoveredChars } from "../../../core/viz/fonts";
import { FONT_FILES, LICENSE_FILES } from "../../../core/viz/fonts/manifest";

const DIR = path.join(import.meta.dir, "..", "..", "..", "core", "viz", "fonts");
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const base64 = (file: string): string => Buffer.from(readAsset(path.join(DIR, file))).toString("base64");

describe("committed font files", () => {
  test("every font file has its pinned size, the wOF2 magic and its pinned SHA-256", () => {
    expect(FONT_FILES.length).toBe(5);
    for (const f of FONT_FILES) {
      const bytes = readAsset(path.join(DIR, f.file));
      expect([f.file, statSync(path.join(DIR, f.file)).size, bytes.length]).toEqual([f.file, f.bytes, f.bytes]);
      expect([f.file, new TextDecoder().decode(bytes.subarray(0, 4))]).toEqual([f.file, "wOF2"]);
      expect([f.file, sha256(bytes)]).toEqual([f.file, f.sha256]);
    }
  });

  test("every license has its pinned size and SHA-256, the OFL 1.1 title and its copyright line, and no Reserved Font Name", () => {
    expect(LICENSE_FILES.length).toBe(3);
    for (const l of LICENSE_FILES) {
      const bytes = readAsset(path.join(DIR, l.file));
      expect([l.file, bytes.length, sha256(bytes)]).toEqual([l.file, l.bytes, l.sha256]);
      const text = new TextDecoder().decode(bytes);
      expect(text).toContain("SIL OPEN FONT LICENSE Version 1.1");
      expect(text).toContain(l.copyright);
      expect(text).not.toContain("with Reserved Font Name");
    }
  });

  test("no stray font: every .woff2 in the folder is in the manifest", () => {
    const listed = new Set(FONT_FILES.map((f) => f.file));
    expect(readdirSync(DIR).filter((f) => f.endsWith(".woff2") && !listed.has(f))).toEqual([]);
  });
});

describe("fontFaceCss", () => {
  const rules = (css: string): string[] => css.match(/@font-face\{[^}]*\}/g) ?? [];

  test("one @font-face per file, in manifest order, each with its file's base64, range and descriptors", () => {
    const css = fontFaceCss();
    const all = rules(css);
    expect(all.length).toBe(5);
    expect(css.match(/@font-face/g)?.length).toBe(5);
    FONT_FILES.forEach((f, i) => {
      const r = all[i]!;
      expect(r).toContain(`font-family:"${f.cssFamily}"`);
      expect(r).toContain(`src:url(data:font/woff2;base64,${base64(f.file)}) format("woff2")`);
      expect(r).toContain(`font-weight:${f.weight}`);
      expect(r).toContain("font-style:normal");
      expect(r).toContain("font-display:block");
      expect(r).toContain(`unicode-range:${f.unicodeRange}`);
      expect(r.includes("font-stretch:")).toBe(f.stretch !== undefined);
    });
    expect(all[0]).toContain('font-family:"Archivo Variable"');
    expect(all[0]).toContain("font-stretch:62% 125%");
  });

  test("a family filter keeps only that family's rules; the result is the same on every call", () => {
    const mono = rules(fontFaceCss({ families: ["mono"] }));
    expect(mono.length).toBe(3);
    for (const r of mono) expect(r).toContain('font-family:"JetBrains Mono Variable"');
    expect(fontFaceCss()).toBe(fontFaceCss());
    expect(fontFaceCss({ families: [] })).toBe("");
  });
});

describe("coverage", () => {
  test("characters the embedded ranges cover, and those they do not, in code point order", () => {
    expect(uncoveredChars("Leverage 71 [63–78] · “ok” −0.42 ρ Φ é Ł …")).toEqual([]);
    expect(uncoveredChars("→ ≥ ▲ 漢")).toEqual(["→", "≥", "▲", "漢"]);
    expect(uncoveredChars("漢→漢→")).toEqual(["→", "漢"]);
    expect(uncoveredChars("")).toEqual([]);
  });

  test("coverage per family", () => {
    expect(coveredBy("ρ", "mono")).toBe(true);
    expect(coveredBy("é", "serif")).toBe(true);
    expect(coveredBy("Ł", "mono")).toBe(true);
    expect(coveredBy("ρ", "serif")).toBe(false);
    expect(coveredBy("Ł", "display")).toBe(false);
  });
});

describe("fontLicenses", () => {
  test("one OFL 1.1 entry per license file, with its copyright line and full text", () => {
    const ls = fontLicenses();
    expect(ls.map((l) => [l.family, l.copyright, l.license])).toEqual([
      ["Archivo", "Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)", "SIL Open Font License 1.1"],
      ["JetBrains Mono", "Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)", "SIL Open Font License 1.1"],
      ["Newsreader", "Copyright 2020 The Newsreader Project Authors (http://github.com/productiontype/Newsreader)", "SIL Open Font License 1.1"],
    ]);
    LICENSE_FILES.forEach((l, i) => expect(ls[i]!.text).toBe(new TextDecoder().decode(readAsset(path.join(DIR, l.file)))));
  });
});
