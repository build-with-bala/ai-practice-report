/**
 * The assay-certificate design tokens shared by both products: three colour themes, the type and print scales, the
 * spacing scale and the fixed heat levels. The values are the plan's pinned Design system, exactly; `contrast.ts`
 * holds the pairs that must stay legible and a test checks every one of them.
 */

/** `ink` is the dark screen theme, `paper` the light one, and `print` a refinement of paper for the printed page. */
export type ThemeName = "ink" | "paper" | "print";

export type ColorToken = "bg" | "surface" | "raised" | "rule" | "axis" | "ink" | "muted" | "faint" | "ref" | "gold" | "goldHi"
  | "vermilion" | "verdigris" | "onAccent" | "heat0" | "heat1" | "heat2" | "heat3" | "heat4";

type Theme = Readonly<Record<ColorToken, string>>;

const INK: Theme = {
  bg: "#0B0E13", surface: "#11161E", raised: "#18202B", rule: "#232C3A", axis: "#69758C",
  ink: "#EDE7DA", muted: "#B0B7C4", faint: "#8D97AA", ref: "#8D97AA",
  gold: "#D8A443", goldHi: "#EBC06E", vermilion: "#F0705A", verdigris: "#5BC2A7", onAccent: "#0B0E13",
  heat0: "#1A212C", heat1: "#3D3524", heat2: "#6A532B", heat3: "#A07B36", heat4: "#D8A443",
};

const PAPER: Theme = {
  bg: "#F6F1E6", surface: "#EDE6D6", raised: "#E3DAC6", rule: "#D6CCB7", axis: "#7A715F",
  ink: "#17150F", muted: "#4B463C", faint: "#655E51", ref: "#655E51",
  gold: "#7E5A0C", goldHi: "#5E420A", vermilion: "#AD3418", verdigris: "#1F6B57", onAccent: "#F6F1E6",
  heat0: "#E6DDCA", heat1: "#D9C291", heat2: "#C49C50", heat3: "#9C7222", heat4: "#694A0C",
};

/** Print keeps paper's ink and accent tokens and overrides only the grounds, `rule` and `onAccent` (pre-flight F18). */
const PRINT: Theme = { ...PAPER, bg: "#FFFFFF", surface: "#FFFFFF", raised: "#F3EFE6", rule: "#DDD6C8", onAccent: "#FFFFFF" };

export const THEMES: Readonly<Record<ThemeName, Theme>> = { ink: INK, paper: PAPER, print: PRINT };

/** Screen type sizes in px: the only sizes any type role uses. */
export const TYPE_SCALE = [12, 14, 16, 20, 28, 44, 64] as const;
/** The print size in pt of each `TYPE_SCALE` entry, index for index. */
export const PRINT_SCALE_PT = [7.5, 9, 10, 12, 16, 24, 32] as const;
/** The sizes the expanded display face is set at: caps only, never below 18 px. */
export const DISPLAY_SIZES = [20, 28, 44] as const;
/** The spacing scale `--s1`…`--s9`, in px. */
export const SPACE = [4, 8, 12, 16, 24, 32, 48, 64, 96] as const;

/** The fixed heat level of a week by its active days: 0 → 0; 1–2 → 1; 3–4 → 2; 5–6 → 3; 7 → 4. */
export function heatLevel(activeDaysInWeek: number): 0 | 1 | 2 | 3 | 4 {
  const d = activeDaysInWeek;
  if (!(d > 0)) return 0;
  if (d <= 2) return 1;
  if (d <= 4) return 2;
  if (d <= 6) return 3;
  return 4;
}
