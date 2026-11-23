import { FONT_STACK } from "./fonts";
import { PRINT_SCALE_PT, SPACE, THEMES, TYPE_SCALE, type ColorToken, type ThemeName } from "./tokens";

/*
 * The kit stylesheet: the plan's pinned Design system as CSS, shared by both products' reports.
 *
 * Custom properties: each colour token is `--<token>` in kebab case (`--bg`, `--gold-hi`, `--on-accent`, `--heat-0`…), and
 * the spacing scale is `--s1`…`--s9`. Themes: `html[data-theme="ink"|"paper"]` picks one; `auto` (or no attribute)
 * follows `prefers-color-scheme`, with ink when there is no preference; print always uses the print tokens.
 *
 * Gold is kept for the subject's measurements, the seal and the `Ex.` letter; goldHi for the focus ring and the cited
 * exhibit's outline. Hover, current, pressed and selection states are neutral (ink, with an underline or a border).
 *
 * Classes the primitives and pages build on:
 * - type roles `t-disp-*`, `t-serif-*`, `t-mono-*` (the only type classes), colour utilities `c-<token>`;
 * - marks `m-*` (SVG fills and strokes; `m-stroke` draws a mark's colour as a stroke instead of a fill, its width set by
 *   the element's `stroke-width`);
 * - layout `layout`, `rail`, `chapter-bar`, `masthead`, `kit-controls`, `chapter`, `skip-link`, `scroll-x` with `mw-960`
 *   and `mw-888` (`data-print="fit"` lets a marks-only SVG scale to the printed column), `kit-defs` and `kit-hatch-line` (the hatch pattern's stroke), `print-footer`, `icon`;
 * - components `exhibit` (`exhibit__head`, `exhibit__letter`, `exhibit__tag`, `exhibit__note`, `exhibit__placeholder`,
 *   `exhibit--thin`, `exhibit--empty`, `is-cited`), `cite`, `ledger` (`ledger-row`, `ledger-row__label`, `__rule`,
 *   `__value`, `__dots`, `__window`, `ledger-components`), `seal` (`seal--struck|provisional|flagged`, `seal-ring`,
 *   `seal-disc`, `seal-text`, `seal-outline`, `seal-ringtext`, `seal__meta`), `tree`, `dots`, `tag`.
 */

/**
 * The kit's class vocabulary: every class the stylesheet styles, and the only classes renderers and pages may use. A
 * test checks the list against `kitCss` both ways, so renderers and the stylesheet fail together.
 */
export const KIT_CLASSES: readonly string[] = [
  // type roles
  "t-disp-44", "t-disp-28", "t-disp-20", "t-serif-20", "t-serif-16", "t-mono-64", "t-mono-44", "t-mono-20", "t-mono-16", "t-mono-14", "t-mono-12",
  // text colour utilities
  "c-ink", "c-muted", "c-faint", "c-vermilion", "c-verdigris",
  // marks
  "m-solid", "m-hollow", "m-hatch", "m-ref", "m-axis", "m-flag", "m-pass", "m-heat-0", "m-heat-1", "m-heat-2", "m-heat-3", "m-heat-4",
  "m-prompt", "m-wait", "m-track", "m-stroke",
  // layout
  "page", "layout", "rail", "chapter-bar", "masthead", "kit-controls", "chapter", "skip-link", "scroll-x", "mw-960", "mw-888",
  "kit-defs", "kit-hatch-line", "print-footer", "no-margin-boxes", "icon",
  // components
  "num", "tag", "dots", "cite",
  "exhibit", "exhibit__head", "exhibit__letter", "exhibit__tag", "exhibit__note", "exhibit__placeholder", "exhibit--thin", "exhibit--empty", "is-cited",
  "ledger", "ledger-group", "ledger-row", "ledger-row__label", "ledger-row__rule", "ledger-row__value", "ledger-row__dots", "ledger-row__window",
  "ledger-components",
  "seal", "seal--struck", "seal--provisional", "seal--flagged", "seal-ring", "seal-disc", "seal-text", "seal-outline", "seal-ringtext", "seal__meta",
  "tree",
];

const kebab = (token: ColorToken): string => token.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()).replace(/(\d)$/, "-$1");
const v = (token: ColorToken): string => `var(--${kebab(token)})`;
const rule = (selector: string, decls: readonly string[]): string => `${selector}{${decls.join(";")}}`;
const media = (query: string, rules: readonly string[]): string => `@media ${query}{${rules.join("")}}`;

const themeVars = (theme: ThemeName): string[] =>
  (Object.entries(THEMES[theme]) as [ColorToken, string][]).map(([token, hex]) => `--${kebab(token)}:${hex}`);
const scheme = (theme: ThemeName): string => `color-scheme:${theme === "ink" ? "dark" : "light"}`;

/** A CSS string literal of `s`: `\` and `"` escaped, a newline as `\A `, `<` and `>` as hex escapes (so no raw `</style>`), other control characters and lone surrogates dropped (pre-flight F6). */
export function cssString(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\A ";
    else if (ch === "<") out += "\\3C ";
    else if (ch === ">") out += "\\3E ";
    else if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0xd800 && cp <= 0xdfff)) continue;
    else out += ch;
  }
  return `"${out}"`;
}

/* ---------- type roles ---------- */

interface TypeRole { cls: string; family: "display" | "serif" | "mono"; px: (typeof TYPE_SCALE)[number]; weight: number; lineHeight: number; tracking: string; caps?: true; measure?: string }

/** The Design system's type-roles table. */
const TYPE_ROLES: readonly TypeRole[] = [
  { cls: "t-disp-44", family: "display", px: 44, weight: 760, lineHeight: 1, tracking: ".02em" },
  { cls: "t-disp-28", family: "display", px: 28, weight: 720, lineHeight: 1.05, tracking: ".06em" },
  { cls: "t-disp-20", family: "display", px: 20, weight: 700, lineHeight: 1.1, tracking: ".08em" },
  { cls: "t-serif-20", family: "serif", px: 20, weight: 420, lineHeight: 1.45, tracking: "0" },
  { cls: "t-serif-16", family: "serif", px: 16, weight: 400, lineHeight: 1.55, tracking: "0", measure: "66ch" },
  { cls: "t-mono-64", family: "mono", px: 64, weight: 600, lineHeight: 1, tracking: "0" },
  { cls: "t-mono-44", family: "mono", px: 44, weight: 600, lineHeight: 1, tracking: "0" },
  { cls: "t-mono-20", family: "mono", px: 20, weight: 500, lineHeight: 1.3, tracking: "0" },
  { cls: "t-mono-16", family: "mono", px: 16, weight: 500, lineHeight: 1.4, tracking: "0" },
  { cls: "t-mono-14", family: "mono", px: 14, weight: 400, lineHeight: 1.45, tracking: "0" },
  { cls: "t-mono-12", family: "mono", px: 12, weight: 500, lineHeight: 1.4, tracking: ".08em", caps: true },
];

const printPt = (px: (typeof TYPE_SCALE)[number]): number => PRINT_SCALE_PT[TYPE_SCALE.indexOf(px)]!;

const typeRule = (r: TypeRole): string => rule(`.${r.cls}`, [
  `font-family:${FONT_STACK[r.family]}`,
  `font-size:${r.px}px`,
  `font-weight:${r.weight}`,
  `line-height:${r.lineHeight}`,
  `letter-spacing:${r.tracking}`,
  "font-synthesis:none",
  ...(r.family === "mono" ? ["font-variant-numeric:tabular-nums slashed-zero"] : []),
  ...(r.family === "display" ? ["font-stretch:125%", "text-transform:uppercase"] : []),
  ...(r.caps ? ["text-transform:uppercase"] : []),
  ...(r.measure ? [`max-width:${r.measure}`] : []),
]);

/** Mono 12 caps, for tags and labels that are not themselves a `t-mono-12` element. */
const MONO_12_CAPS = [`font-family:${FONT_STACK.mono}`, "font-size:12px", "font-weight:500", "line-height:1.4", "letter-spacing:.08em",
  "text-transform:uppercase", "font-variant-numeric:tabular-nums slashed-zero", "font-synthesis:none"];

/* ---------- sections ---------- */

/** Text colour utilities. Gold is not one: it is kept for the subject's measurements and the seal, which have their own classes. */
const TEXT_TOKENS: readonly ColorToken[] = ["ink", "muted", "faint", "vermilion", "verdigris"];

function themes(): string[] {
  return [
    rule(':root,:root[data-theme="ink"]', [...themeVars("ink"), scheme("ink")]),
    media("(prefers-color-scheme:light)", [rule(':root:not([data-theme="ink"])', [...themeVars("paper"), scheme("paper")])]),
    rule(':root[data-theme="paper"]', [...themeVars("paper"), scheme("paper")]),
    rule(":root", SPACE.map((px, i) => `--s${i + 1}:${px}px`)),
  ];
}

function base(): string[] {
  return [
    rule("*,*::before,*::after", ["box-sizing:border-box"]),
    rule("html", ["-webkit-text-size-adjust:100%", "text-size-adjust:100%", "scroll-padding-top:var(--s8)"]),
    rule("body", [`margin:0`, `background:${v("bg")}`, `color:${v("ink")}`, `font-family:${FONT_STACK.serif}`, "font-size:16px",
      "line-height:1.55", "font-synthesis:none", "-webkit-font-smoothing:antialiased", "text-rendering:optimizeLegibility"]),
    rule("h1,h2,h3,h4,p,figure,blockquote", ["margin:0"]),
    rule("h1,h2,h3,h4", ["font-weight:inherit"]),
    rule("a", ["color:inherit", `text-decoration-color:${v("axis")}`, "text-underline-offset:.2em"]),
    rule("a:hover", [`text-decoration-color:${v("ink")}`]),
    rule(":focus-visible", [`outline:2px solid ${v("goldHi")}`, "outline-offset:2px"]),
    rule("::selection", [`background:${v("ink")}`, `color:${v("bg")}`]),
    rule("button", ["font:inherit", "color:inherit", "background:none", "border:0", "padding:0", "cursor:pointer", "border-radius:0"]),
    rule("table", ["border-collapse:collapse", "width:100%", `font-family:${FONT_STACK.mono}`, "font-size:14px", "line-height:1.45",
      "font-variant-numeric:tabular-nums slashed-zero", "font-synthesis:none"]),
    rule("th,td", ["text-align:left", "vertical-align:baseline", `padding:var(--s2) var(--s3)`, `border-bottom:1px solid ${v("rule")}`]),
    rule("th", [...MONO_12_CAPS, `color:${v("faint")}`, `background:${v("raised")}`]),
    rule("td.num,th.num", ["text-align:right"]),
    rule("summary", ["cursor:pointer", "list-style:none"]),
    rule("summary::-webkit-details-marker", ["display:none"]),
    rule("svg text", ["fill:currentColor"]),
    ...TEXT_TOKENS.map((t) => rule(`.c-${kebab(t)}`, [`color:${v(t)}`])),
  ];
}

function layout(): string[] {
  return [
    rule(".skip-link", ["position:absolute", "left:var(--s4)", "top:-100px", "z-index:3", `padding:var(--s2) var(--s4)`,
      `background:${v("bg")}`, `color:${v("ink")}`, `border:1px solid ${v("ink")}`, ...MONO_12_CAPS]),
    rule(".skip-link:focus", ["top:var(--s4)"]),
    rule(".page", ["max-width:1360px", "margin:0 auto", "padding:0 var(--s6) var(--s9)"]),
    rule(".masthead", ["display:flex", "flex-wrap:wrap", "align-items:center", "justify-content:space-between", "gap:var(--s3) var(--s6)",
      "padding:var(--s4) 0", `border-bottom:1px solid ${v("rule")}`, "margin-bottom:var(--s8)"]),
    rule(".kit-controls", ["display:flex", "gap:var(--s2)"]),
    rule(".kit-controls button", ["display:inline-flex", "align-items:center", "gap:var(--s2)", "padding:var(--s2) var(--s3)",
      `border:1px solid ${v("axis")}`, ...MONO_12_CAPS]),
    rule('.kit-controls button:hover,.kit-controls button[aria-pressed="true"]', [`border-color:${v("ink")}`, `color:${v("ink")}`]),
    rule(".rail", ["display:none"]),
    rule(".rail ol,.chapter-bar ol", ["list-style:none", "margin:0", "padding:0"]),
    rule(".rail a,.chapter-bar a", [...MONO_12_CAPS, `color:${v("muted")}`, "text-decoration:none"]),
    rule(".rail a:hover,.chapter-bar a:hover,.rail a[aria-current],.chapter-bar a[aria-current]", [`color:${v("ink")}`,
      "text-decoration:underline", `text-decoration-color:${v("ink")}`, "text-underline-offset:.3em"]),
    rule(".chapter-bar", ["position:sticky", "top:0", "z-index:2", `background:${v("bg")}`, `border-bottom:1px solid ${v("rule")}`,
      "overflow-x:auto", "overscroll-behavior-x:contain", "white-space:nowrap", "margin-bottom:var(--s8)"]),
    rule(".chapter-bar ol", ["display:flex", "gap:var(--s5)", "padding:var(--s3) 0"]),
    rule(".chapter + .chapter", ["margin-top:var(--s9)"]),
    rule(".chapter>h2", ["padding-bottom:var(--s3)", `border-bottom:1px solid ${v("rule")}`, "margin-bottom:var(--s7)"]),
    rule(".scroll-x", ["overflow-x:auto", "overscroll-behavior-x:contain", "-webkit-overflow-scrolling:touch"]),
    rule(".scroll-x>svg", ["display:block"]),
    rule(".mw-960", ["min-width:960px"]),
    rule(".mw-888", ["min-width:888px"]),
    rule(".kit-defs", ["position:absolute", "width:0", "height:0", "overflow:hidden"]),
    rule(".kit-hatch-line", [`stroke:${v("ref")}`, "stroke-width:1"]),
    rule(".icon", ["display:inline-block", "width:12px", "height:12px", "flex:none", "fill:currentColor", "vertical-align:-1px"]),
    rule(".print-footer", ["display:none"]),
    media("(min-width:640px)", [rule(".chapter-bar", ["white-space:normal"]), rule(".chapter-bar ol", ["flex-wrap:wrap", "gap:var(--s2) var(--s5)"])]),
    media("(min-width:1024px)", [
      rule(".layout", ["display:grid", "grid-template-columns:208px minmax(0,1040px)", "gap:48px", "justify-content:center"]),
      rule(".rail", ["display:block", "position:sticky", "top:var(--s6)", "align-self:start"]),
      rule(".rail ol", ["display:grid", "gap:var(--s3)"]),
      rule(".chapter-bar", ["display:none"]),
      rule("html", ["scroll-padding-top:var(--s6)"]),
    ]),
  ];
}

function components(): string[] {
  return [
    // tags, dots, cites
    rule(".tag", [...MONO_12_CAPS, `color:${v("faint")}`]),
    rule(".dots", ["display:inline-flex", "gap:3px", "vertical-align:middle"]),
    // A cite (a button, see `cite` in html.ts) is neutral; the exhibit it points at takes the goldHi outline (`is-cited`), and focus the goldHi ring.
    rule(".cite", [`color:${v("ink")}`, "text-decoration:none", `border-bottom:1px solid ${v("axis")}`]),
    rule(".cite:hover,.cite:focus-visible,.cite[aria-pressed=\"true\"]", [`border-bottom-color:${v("ink")}`]),
    // exhibit frame
    rule("figure.exhibit", [`padding:var(--s5)`, `background:${v("surface")}`, "outline:2px solid transparent", "outline-offset:2px",
      "transition:outline-color 160ms ease-out"]),
    rule("figure.exhibit.is-cited", [`outline-color:${v("goldHi")}`]),
    rule(".exhibit + .exhibit", ["margin-top:var(--s7)"]),
    rule(".exhibit__head", ["display:flex", "flex-wrap:wrap", "align-items:baseline", "gap:var(--s2) var(--s4)", "margin-bottom:var(--s5)"]),
    rule(".exhibit__letter", [`color:${v("gold")}`]),
    rule(".exhibit__tag", ["margin-left:auto", `color:${v("faint")}`]),
    rule(".exhibit figcaption", [`font-family:${FONT_STACK.serif}`, "font-size:16px", "line-height:1.55", "max-width:66ch",
      `color:${v("muted")}`, "margin-top:var(--s5)"]),
    rule(".exhibit__note", [`border:1.5px solid ${v("gold")}`, `padding:var(--s3) var(--s4)`, `color:${v("muted")}`]),
    rule(".exhibit__placeholder", ["display:block", "width:100%", "height:48px"]),
    rule(".exhibit--thin .exhibit__note", ["margin-bottom:var(--s5)"]),
    rule(".exhibit--empty .exhibit__note", ["margin-top:var(--s4)"]),
    // assay ledger
    rule(".ledger", ["display:grid", "gap:var(--s3)"]),
    rule(".ledger-group>h3,.ledger-group>.tag", ["margin:var(--s5) 0 var(--s2)"]),
    rule(".ledger-row>summary", ["display:grid", "grid-template-columns:minmax(0,160px) minmax(0,1fr) 128px 36px 64px",
      "grid-template-areas:\"label rule value dots window\"", "align-items:center", "gap:var(--s4)", "padding:var(--s1) 0"]),
    rule(".ledger-row__label", ["grid-area:label"]),
    rule(".ledger-row__rule", ["grid-area:rule", "display:block", "width:100%", "height:24px"]),
    rule(".ledger-row__value", ["grid-area:value", "white-space:nowrap"]),
    rule(".ledger-row__dots", ["grid-area:dots"]),
    rule(".ledger-row__window", ["grid-area:window", "text-align:right"]),
    rule(".ledger-row[open]>summary,.ledger-row>summary:hover", [`background:${v("raised")}`]),
    rule(".ledger-components", ["margin:var(--s2) 0 var(--s4)"]),
    // seal
    rule(".seal", ["display:inline-grid", "justify-items:center", "gap:var(--s2)", `color:${v("gold")}`]),
    rule(".seal>svg", ["display:block", "width:192px", "height:192px", "overflow:visible"]),
    rule(".seal-ring", ["fill:none", "stroke:currentColor"]),
    rule(".seal-disc", ["fill:none"]),
    rule(".seal-text", ["fill:currentColor"]),
    rule(".seal-outline", ["fill:none", "stroke:currentColor", "stroke-width:1"]),
    rule(".seal-ringtext", ["fill:currentColor", "font-size:12px", "letter-spacing:.12em", "text-transform:uppercase"]),
    rule(".seal--struck .seal-disc", ["fill:currentColor"]),
    rule(".seal--struck .seal-text", [`fill:${v("onAccent")}`]),
    rule(".seal--struck>svg", ["animation:kit-strike 420ms cubic-bezier(.2,.8,.2,1)"]),
    rule(".seal--provisional .seal-disc", ["fill:none"]),
    rule(".seal--flagged", [`color:${v("vermilion")}`]),
    rule(".seal__meta", ["display:grid", "justify-items:center", "gap:var(--s1)", `color:${v("muted")}`]),
    // delegation outline: branches are borders
    rule("ol.tree,.tree ol", ["list-style:none", "margin:0", "padding:0"]),
    rule(".tree", [`font-family:${FONT_STACK.mono}`, "font-size:14px", "line-height:1.45", "font-variant-numeric:tabular-nums slashed-zero",
      "font-synthesis:none"]),
    rule(".tree ol", ["margin-left:var(--s2)"]),
    rule(".tree ol>li", ["position:relative", "padding-left:var(--s5)"]),
    rule(".tree ol>li::before", ["content:\"\"", "position:absolute", "left:0", "top:0", "bottom:0", `border-left:1px solid ${v("axis")}`]),
    rule(".tree ol>li:last-child::before", ["bottom:auto", "height:.725em"]),
    rule(".tree ol>li::after", ["content:\"\"", "position:absolute", "left:0", "top:.725em", "width:var(--s4)", `border-top:1px solid ${v("axis")}`]),
    rule(".tree svg", ["display:inline-block", "vertical-align:middle", "margin-left:var(--s2)"]),
    media("(max-width:639px)", [
      rule(".page", ["padding:0 var(--s4) var(--s8)"]),
      rule(".chapter + .chapter", ["margin-top:var(--s8)"]),
      rule(".ledger-row>summary", ["grid-template-columns:minmax(0,1fr) auto auto", "grid-template-areas:\"label value dots\" \"rule rule rule\" \"window window window\"",
        "gap:var(--s1) var(--s3)"]),
      rule(".ledger-row__window", ["text-align:left"]),
      rule(".seal>svg", ["width:144px", "height:144px"]),
      rule(".seal-ringtext", ["display:none"]),
      rule("figure.exhibit", ["padding:var(--s4)"]),
    ]),
  ];
}

function marks(): string[] {
  const fill = (cls: string, token: ColorToken, extra: readonly string[] = []): string =>
    rule(`.${cls}`, [`fill:${v(token)}`, `color:${v(token)}`, ...extra]);
  return [
    fill("m-solid", "gold"),
    rule(".m-hollow", [`fill:${v("bg")}`, `stroke:${v("gold")}`, "stroke-width:1.5", `color:${v("gold")}`]),
    rule(".m-hatch", ["fill:url(#kit-hatch)", `color:${v("ref")}`]),
    rule(".m-ref", ["fill:none", `stroke:${v("ref")}`, "stroke-width:1", "stroke-dasharray:2 2", `color:${v("ref")}`]),
    rule(".m-axis", ["fill:none", `stroke:${v("axis")}`, "stroke-width:1", `color:${v("axis")}`]),
    rule("circle.m-axis", [`fill:${v("axis")}`, "stroke:none"]),
    fill("m-flag", "vermilion"),
    fill("m-pass", "verdigris"),
    ...([0, 1, 2, 3, 4] as const).map((n) => fill(`m-heat-${n}`, `heat${n}`)),
    fill("m-prompt", "ink"),
    rule(".m-wait", ["fill:none", `stroke:${v("faint")}`, "stroke-width:1", "stroke-dasharray:1 3", `color:${v("faint")}`]),
    fill("m-track", "raised"),
    rule(".m-stroke", ["fill:none", "stroke:currentColor"]),
  ];
}

function motion(): string[] {
  return [
    "@keyframes kit-strike{0%{transform:scale(1.12) rotate(-6deg);opacity:0}60%{transform:scale(.98) rotate(.5deg);opacity:1}100%{transform:none;opacity:1}}",
    media("(prefers-reduced-motion:reduce)", [rule("*,*::before,*::after", ["animation:none!important", "transition:none!important"])]),
  ];
}

function print(footerLeft: string): string[] {
  const faint = THEMES.print.faint;
  const box = [`font-family:${FONT_STACK.mono}`, "font-size:7.5pt", "font-weight:500", "letter-spacing:.08em", `color:${faint}`];
  return [
    `@page{margin:14mm;@bottom-left{${[`content:${cssString(footerLeft)}`, ...box].join(";")}}@bottom-right{${[
      'content:"p " counter(page) "/" counter(pages)', ...box].join(";")}}}`,
    media("print", [
      // `:is()` takes its most specific argument, so this outranks every screen theme rule, with or without the attribute.
      rule(":root:is([data-theme],:not([data-theme]))", [...themeVars("print"), scheme("print")]),
      rule("*", ["print-color-adjust:exact", "-webkit-print-color-adjust:exact"]),
      rule("body", ["font-size:10pt"]),
      ...TYPE_ROLES.map((r) => rule(`.${r.cls}`, [`font-size:${printPt(r.px)}pt`])),
      rule(".rail,.chapter-bar,.kit-controls,[data-print=\"skip\"]", ["display:none!important"]),
      rule(".layout", ["display:block"]),
      rule(".page", ["max-width:none", "padding:0"]),
      rule(".chapter + .chapter", ["break-before:page", "margin-top:0"]),
      rule("figure.exhibit", ["break-inside:avoid", "outline:none"]),
      rule("tr,.ledger-row", ["break-inside:avoid"]),
      // Only a marks-only SVG may scale to the column; a chart with text keeps its size and Task 7 gives it a print layout.
      rule('.scroll-x[data-print="fit"]>svg', ["min-width:0", "width:100%"]),
      rule(".seal>svg", ["width:48mm", "height:48mm", "animation:none"]),
      rule("html.no-margin-boxes .print-footer", ["display:flex", "position:fixed", "left:0", "right:0", "bottom:0",
        "justify-content:space-between", ...box]),
    ]),
  ];
}

/** The kit stylesheet: themes, base styles, type roles, layout, components, marks, motion and print. Deterministic. */
export function kitCss(o: { footerLeft: string }): string {
  return [
    ...themes(),
    ...base(),
    ...TYPE_ROLES.map(typeRule),
    ...layout(),
    ...components(),
    ...marks(),
    ...motion(),
    ...print(o.footerLeft),
  ].join("\n");
}
