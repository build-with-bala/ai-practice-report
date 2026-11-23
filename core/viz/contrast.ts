import { THEMES, type ColorToken, type ThemeName } from "./tokens";

/** WCAG 2.x relative luminance of a `#RRGGBB` colour, from 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (m === null) throw new Error(`not a #RRGGBB colour: ${JSON.stringify(hex)}`);
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((c) => {
    const s = parseInt(c, 16) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** The WCAG contrast ratio of two colours, `(L1 + 0.05) / (L2 + 0.05)` with L1 the lighter; the same in either order. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface ContrastRow { theme: ThemeName; fg: ColorToken; bg: ColorToken; kind: "text" | "mark" | "accent"; ratio: number; ok: boolean }

const GROUNDS: readonly ColorToken[] = ["bg", "surface", "raised"];
const TEXT: readonly ColorToken[] = ["ink", "muted", "faint", "ref", "gold", "goldHi", "vermilion", "verdigris"];
const MARK: readonly ColorToken[] = ["gold", "goldHi", "ref", "axis", "vermilion", "verdigris", "heat4"];
const ACCENTS: readonly ColorToken[] = ["gold", "vermilion", "verdigris"];
const MIN: Readonly<Record<ContrastRow["kind"], number>> = { text: 4.5, mark: 3, accent: 4.5 };

/**
 * Every pair the design system promises, in every theme: text tokens at least 4.5:1 and mark tokens at least 3:1 on
 * each ground, and `onAccent` at least 4.5:1 on each accent.
 */
export function contrastReport(): ContrastRow[] {
  const rows: ContrastRow[] = [];
  for (const theme of Object.keys(THEMES) as ThemeName[]) {
    const t = THEMES[theme];
    const row = (kind: ContrastRow["kind"], fg: ColorToken, bg: ColorToken): void => {
      const ratio = contrast(t[fg], t[bg]);
      rows.push({ theme, fg, bg, kind, ratio, ok: ratio >= MIN[kind] });
    };
    for (const fg of TEXT) for (const bg of GROUNDS) row("text", fg, bg);
    for (const fg of MARK) for (const bg of GROUNDS) row("mark", fg, bg);
    for (const bg of ACCENTS) row("accent", "onAccent", bg);
  }
  return rows;
}
