/**
 * The embedded fonts, pinned: Fontsource 5.3.0 Latin-subset variable `.woff2` files and each package's OFL 1.1 license,
 * fetched once by exact version from jsDelivr's npm mirror (`scripts/fonts-fetch.ts`) and committed beside this file.
 * Every file is pinned by size and SHA-256; a test checks the committed bytes against these values.
 */

/** A font's role: mono for measurements, display for structure, serif for interpretation. */
export type FontFamily = "mono" | "display" | "serif";

export interface FontFile {
  file: string;
  family: FontFamily;
  cssFamily: string;
  url: string;
  sha256: string;
  bytes: number;
  /** The variable weight axis, as `font-weight` takes it. */
  weight: string;
  /** The variable width axis, as `font-stretch` takes it (Archivo only). */
  stretch?: string;
  /** Fontsource's own `unicode-range` for the subset. */
  unicodeRange: string;
}

export interface LicenseFile {
  file: string;
  families: readonly FontFamily[];
  url: string;
  sha256: string;
  bytes: number;
  /** The license's first line, up to its closing parenthesis. */
  copyright: string;
}

const BASE = "https://cdn.jsdelivr.net/npm/@fontsource-variable";
const VERSION = "5.3.0";
const fileUrl = (pkg: string, file: string): string => `${BASE}/${pkg}@${VERSION}/files/${file}`;
const licenseUrl = (pkg: string): string => `${BASE}/${pkg}@${VERSION}/LICENSE`;

const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";
const GREEK = "U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF";

const ARCHIVO = "archivo";
const MONO = "jetbrains-mono";
const NEWSREADER = "newsreader";

export const FONT_FILES: readonly FontFile[] = [
  {
    file: "archivo-latin-wdth-normal.woff2", family: "display", cssFamily: "Archivo Variable",
    url: fileUrl(ARCHIVO, "archivo-latin-wdth-normal.woff2"),
    sha256: "e3a28eade21a900c7155a247757f4b2834c07bb7ef07ad7efa55cebaac1e8f5e", bytes: 90104,
    weight: "100 900", stretch: "62% 125%", unicodeRange: LATIN,
  },
  {
    file: "jetbrains-mono-latin-wght-normal.woff2", family: "mono", cssFamily: "JetBrains Mono Variable",
    url: fileUrl(MONO, "jetbrains-mono-latin-wght-normal.woff2"),
    sha256: "18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e", bytes: 40404,
    weight: "100 800", unicodeRange: LATIN,
  },
  {
    file: "jetbrains-mono-latin-ext-wght-normal.woff2", family: "mono", cssFamily: "JetBrains Mono Variable",
    url: fileUrl(MONO, "jetbrains-mono-latin-ext-wght-normal.woff2"),
    sha256: "79bfdab9ba467e26eea4122e6f2567e188dd8a09a8c730d501fc487c4ab99c6e", bytes: 15196,
    weight: "100 800", unicodeRange: LATIN_EXT,
  },
  {
    file: "jetbrains-mono-greek-wght-normal.woff2", family: "mono", cssFamily: "JetBrains Mono Variable",
    url: fileUrl(MONO, "jetbrains-mono-greek-wght-normal.woff2"),
    sha256: "ee863198077f3093ffa81c072581cc4bd608a04e60a8a9c0b846396ce4f14109", bytes: 9004,
    weight: "100 800", unicodeRange: GREEK,
  },
  {
    file: "newsreader-latin-wght-normal.woff2", family: "serif", cssFamily: "Newsreader Variable",
    url: fileUrl(NEWSREADER, "newsreader-latin-wght-normal.woff2"),
    sha256: "62981321d9a3cc7a61a73792729043703fd6112da86e8ec848bb57f088578757", bytes: 58084,
    weight: "200 800", unicodeRange: LATIN,
  },
];

export const LICENSE_FILES: readonly LicenseFile[] = [
  {
    file: "OFL-Archivo.txt", families: ["display"], url: licenseUrl(ARCHIVO),
    sha256: "c3c8402eec0e31dc9a76851235b1c02a0bb821488b2db8e35bcc2ab60ca8fc2b", bytes: 4503,
    copyright: "Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo)",
  },
  {
    file: "OFL-JetBrainsMono.txt", families: ["mono"], url: licenseUrl(MONO),
    sha256: "403581b69dac5cff4079205e01c6b467e56af449ecbd7247693ddb1baafa005b", bytes: 4524,
    copyright: "Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)",
  },
  {
    file: "OFL-Newsreader.txt", families: ["serif"], url: licenseUrl(NEWSREADER),
    sha256: "26028ec4e13b650065fa525a09532176f8a668b76ff849ea01c564a7480f91e7", bytes: 4520,
    copyright: "Copyright 2020 The Newsreader Project Authors (http://github.com/productiontype/Newsreader)",
  },
];
