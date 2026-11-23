import { describe, expect, test } from "bun:test";
import { contrast, contrastReport, luminance } from "../../../core/viz/contrast";
import { heatLevel, THEMES, type ColorToken, type ThemeName } from "../../../core/viz/tokens";

const THEME_NAMES: readonly ThemeName[] = ["ink", "paper", "print"];
const HEAT: readonly ColorToken[] = ["heat0", "heat1", "heat2", "heat3", "heat4"];

describe("luminance and contrast", () => {
  test("WCAG 2.x reference values: black on white is 21, #777 on white is 4.48", () => {
    expect(luminance("#000000")).toBe(0);
    expect(luminance("#FFFFFF")).toBe(1);
    expect(Math.abs(contrast("#000000", "#FFFFFF") - 21)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(contrast("#777777", "#FFFFFF") - 4.48)).toBeLessThanOrEqual(0.01);
    expect(contrast("#FFFFFF", "#777777")).toBe(contrast("#777777", "#FFFFFF"));
  });

  test("a colour that is not #RRGGBB is an error, not a silent 0", () => {
    for (const bad of ["#fff", "777777", "#GGGGGG", "", "#7777777"]) expect(() => luminance(bad)).toThrow();
  });
});

describe("contrastReport", () => {
  const rows = contrastReport();

  test("every pinned pair in every theme: text and accent at least 4.5, marks at least 3", () => {
    const failing = rows.filter((r) => !r.ok).map((r) => `${r.theme} ${r.kind} ${r.fg} on ${r.bg}: ${r.ratio.toFixed(3)}`);
    expect(failing).toEqual([]);
    for (const r of rows) expect(r.ratio).toBeGreaterThanOrEqual(r.kind === "mark" ? 3 : 4.5);
  });

  test("it checks 8 text, 7 mark and 1 accent colour on their 3 grounds, in all three themes", () => {
    expect(rows.length).toBe(3 * (8 * 3 + 7 * 3 + 3));
    for (const theme of THEME_NAMES) {
      const of = (kind: string) => rows.filter((r) => r.theme === theme && r.kind === kind);
      expect(of("text").length).toBe(24);
      expect(of("mark").length).toBe(21);
      expect(of("accent").map((r) => `${r.fg}/${r.bg}`)).toEqual(["onAccent/gold", "onAccent/vermilion", "onAccent/verdigris"]);
    }
  });

  test("each row's ratio is the contrast of the theme's two colours", () => {
    for (const r of rows) expect(r.ratio).toBe(contrast(THEMES[r.theme][r.fg], THEMES[r.theme][r.bg]));
  });
});

describe("tokens", () => {
  test("the heat ramp is monotone: luminance strictly rises in ink and strictly falls in paper and print", () => {
    for (const theme of THEME_NAMES) {
      const l = HEAT.map((t) => luminance(THEMES[theme][t]));
      for (let i = 1; i < l.length; i++) {
        if (theme === "ink") expect(l[i]!).toBeGreaterThan(l[i - 1]!);
        else expect(l[i]!).toBeLessThan(l[i - 1]!);
      }
    }
  });

  test("print refines paper: it overrides only the grounds, rule and onAccent (pre-flight F18)", () => {
    const changed = (Object.keys(THEMES.paper) as ColorToken[]).filter((k) => THEMES.print[k] !== THEMES.paper[k]);
    expect(changed.sort()).toEqual(["bg", "onAccent", "raised", "rule", "surface"]);
    expect(Object.keys(THEMES.print).sort()).toEqual(Object.keys(THEMES.paper).sort());
    expect(Object.keys(THEMES.ink).sort()).toEqual(Object.keys(THEMES.paper).sort());
  });

  test("every token is an upper-case #RRGGBB", () => {
    for (const theme of THEME_NAMES) for (const v of Object.values(THEMES[theme])) expect(v).toMatch(/^#[0-9A-F]{6}$/);
  });

  test("heatLevel maps active days 0…7 to the fixed levels", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(heatLevel)).toEqual([0, 1, 1, 2, 2, 3, 3, 4]);
  });
});

describe("interaction states", () => {
  test("the neutral state pairs pass in every theme: text at least 4.5, borders and underlines at least 3", () => {
    // Rail, chapter bar, controls, cites and the skip link: ink text on every ground; selection: bg on ink.
    const text: [ColorToken, ColorToken][] = [["ink", "bg"], ["ink", "surface"], ["ink", "raised"], ["bg", "ink"]];
    // Hover and pressed borders and underlines (ink), resting button borders and cite underlines (axis).
    const boundary: [ColorToken, ColorToken][] = [["ink", "bg"], ["ink", "surface"], ["axis", "bg"], ["axis", "surface"]];
    const failing: string[] = [];
    for (const theme of THEME_NAMES) {
      const t = THEMES[theme];
      for (const [fg, bg] of text) if (contrast(t[fg], t[bg]) < 4.5) failing.push(`${theme} text ${fg}/${bg}`);
      for (const [fg, bg] of boundary) if (contrast(t[fg], t[bg]) < 3) failing.push(`${theme} boundary ${fg}/${bg}`);
    }
    expect(failing).toEqual([]);
  });
});
