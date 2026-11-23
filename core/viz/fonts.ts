/// <reference path="./assets.d.ts" />
import { readAsset } from "../io/asset";
import { FONT_FILES, LICENSE_FILES, type FontFamily } from "./fonts/manifest";
import archivoLatin from "./fonts/archivo-latin-wdth-normal.woff2" with { type: "file" };
import monoLatin from "./fonts/jetbrains-mono-latin-wght-normal.woff2" with { type: "file" };
import monoLatinExt from "./fonts/jetbrains-mono-latin-ext-wght-normal.woff2" with { type: "file" };
import monoGreek from "./fonts/jetbrains-mono-greek-wght-normal.woff2" with { type: "file" };
import newsreaderLatin from "./fonts/newsreader-latin-wght-normal.woff2" with { type: "file" };
import oflArchivo from "./fonts/OFL-Archivo.txt" with { type: "text" };
import oflMono from "./fonts/OFL-JetBrainsMono.txt" with { type: "text" };
import oflNewsreader from "./fonts/OFL-Newsreader.txt" with { type: "text" };

export type { FontFamily } from "./fonts/manifest";

/** Where each font file is served from, by manifest file name: beside this module, or embedded in a compiled binary. */
const FONT_PATHS: Readonly<Record<string, string>> = {
  "archivo-latin-wdth-normal.woff2": archivoLatin,
  "jetbrains-mono-latin-wght-normal.woff2": monoLatin,
  "jetbrains-mono-latin-ext-wght-normal.woff2": monoLatinExt,
  "jetbrains-mono-greek-wght-normal.woff2": monoGreek,
  "newsreader-latin-wght-normal.woff2": newsreaderLatin,
};
/** Each license's text, by manifest file name. */
const LICENSE_TEXTS: Readonly<Record<string, string>> = {
  "OFL-Archivo.txt": oflArchivo,
  "OFL-JetBrainsMono.txt": oflMono,
  "OFL-Newsreader.txt": oflNewsreader,
};

/** The CSS font stack for each role: the embedded family, then the generic fallback. */
export const FONT_STACK: Readonly<Record<FontFamily, string>> = {
  mono: '"JetBrains Mono Variable", monospace',
  display: '"Archivo Variable", sans-serif',
  serif: '"Newsreader Variable", serif',
};

/** Base64 of each font file, encoded on first use and kept for the life of the process. */
const base64Cache = new Map<string, string>();
function fontBase64(file: string): string {
  let b64 = base64Cache.get(file);
  if (b64 === undefined) {
    const p = FONT_PATHS[file];
    if (p === undefined) throw new Error(`no embedded font file ${file}`);
    b64 = Buffer.from(readAsset(p)).toString("base64");
    base64Cache.set(file, b64);
  }
  return b64;
}

/**
 * The `@font-face` rules that embed the fonts as `data:` URIs: one per file, in manifest order, for the families asked
 * for (all by default).
 */
export function fontFaceCss(o: { families?: readonly FontFamily[] } = {}): string {
  const families = o.families ?? (["mono", "display", "serif"] as const);
  return FONT_FILES.filter((f) => families.includes(f.family)).map((f) => "@font-face{" + [
    `font-family:"${f.cssFamily}"`,
    `src:url(data:font/woff2;base64,${fontBase64(f.file)}) format("woff2")`,
    `font-weight:${f.weight}`,
    ...(f.stretch === undefined ? [] : [`font-stretch:${f.stretch}`]),
    "font-style:normal",
    "font-display:block",
    `unicode-range:${f.unicodeRange}`,
  ].join(";") + "}").join("\n");
}

export interface FontLicense { family: string; copyright: string; license: "SIL Open Font License 1.1"; text: string }

/** One entry per embedded font family: its name, copyright line and full OFL 1.1 text, in manifest order. */
export function fontLicenses(): FontLicense[] {
  return LICENSE_FILES.map((l) => {
    const css = FONT_FILES.find((f) => f.family === l.families[0])!.cssFamily;
    return { family: css.replace(/ Variable$/, ""), copyright: l.copyright, license: "SIL Open Font License 1.1", text: LICENSE_TEXTS[l.file]! };
  });
}

/** A `unicode-range` value as inclusive code point intervals. */
const parseRange = (range: string): [number, number][] =>
  range.split(",").map((part) => {
    const [lo, hi] = part.trim().replace(/^U\+/i, "").split("-");
    const from = parseInt(lo!, 16);
    return [from, hi === undefined ? from : parseInt(hi, 16)];
  });

const RANGES: readonly { family: FontFamily; ranges: [number, number][] }[] = FONT_FILES.map((f) => ({ family: f.family, ranges: parseRange(f.unicodeRange) }));

const inRanges = (cp: number, ranges: readonly [number, number][]): boolean => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

/** Whether one of a family's embedded files covers a character (its first code point). */
export function coveredBy(ch: string, family: FontFamily): boolean {
  const cp = ch.codePointAt(0);
  return cp !== undefined && RANGES.some((r) => r.family === family && inRanges(cp, r.ranges));
}

/** The distinct characters of a text that no embedded file covers, in code point order. */
export function uncoveredChars(text: string): string[] {
  const out = new Set<number>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (!RANGES.some((r) => inRanges(cp, r.ranges))) out.add(cp);
  }
  return [...out].sort((a, b) => a - b).map((cp) => String.fromCodePoint(cp));
}
