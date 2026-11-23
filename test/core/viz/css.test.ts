import { describe, expect, test } from "bun:test";
import { cssString, kitCss } from "../../../core/viz/css";
import { THEMES } from "../../../core/viz/tokens";

const css = kitCss({ footerLeft: "Your practice · No. 0000-0000" });
/** The declarations of a selector's first rule, e.g. `.t-disp-20` → `font-family:…;font-size:20px;…`. */
const ruleOf = (selector: string): string | undefined => {
  const quoted = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`(?:^|[}\\n])${quoted}\\{([^}]*)\\}`))?.[1];
};

const TYPE_CLASSES = ["t-disp-44", "t-disp-28", "t-disp-20", "t-serif-20", "t-serif-16", "t-mono-64", "t-mono-44", "t-mono-20",
  "t-mono-16", "t-mono-14", "t-mono-12"];
const MARK_CLASSES = ["m-solid", "m-hollow", "m-hatch", "m-ref", "m-axis", "m-flag", "m-pass", "m-heat-0", "m-heat-1", "m-heat-2",
  "m-heat-3", "m-heat-4", "m-prompt", "m-wait", "m-track"];

describe("kitCss", () => {
  test("print: page margins, margin boxes, exact colours, page breaks and the fallback footer", () => {
    for (const s of ["@page", "margin:14mm", "@bottom-left", "@bottom-right", "counter(page)", "counter(pages)",
      "print-color-adjust:exact", "-webkit-print-color-adjust:exact", "break-before:page", "break-inside:avoid", ".no-margin-boxes"]) {
      expect([s, css.includes(s)]).toEqual([s, true]);
    }
    expect(css).toContain(`@bottom-left{content:${cssString("Your practice · No. 0000-0000")}`);
  });

  test("behaviour: colour scheme, reduced motion, no synthesis, the strike, the mobile breakpoint, scroll boxes", () => {
    for (const s of ["prefers-color-scheme", "prefers-reduced-motion", "font-synthesis:none", "@keyframes kit-strike",
      "@media (max-width:639px)", ".scroll-x{overflow-x:auto"]) {
      expect([s, css.includes(s)]).toEqual([s, true]);
    }
  });

  test("colours: every token value of every theme occurs", () => {
    for (const [theme, tokens] of Object.entries(THEMES)) {
      for (const [token, hex] of Object.entries(tokens)) expect([theme, token, css.includes(hex)]).toEqual([theme, token, true]);
    }
  });

  test("classes: display roles are expanded caps at 20, 28 and 44 only; every type role and mark class exists", () => {
    for (const c of ["t-disp-20", "t-disp-28", "t-disp-44"]) {
      const rule = ruleOf(`.${c}`);
      expect([c, rule?.includes("text-transform:uppercase"), rule?.includes("font-stretch:125%")]).toEqual([c, true, true]);
    }
    for (const c of ["t-disp-12", "t-disp-14", "t-disp-16"]) expect(css).not.toContain(`.${c}`);
    for (const c of TYPE_CLASSES) {
      const rule = ruleOf(`.${c}`);
      expect([c, rule?.includes("font-synthesis:none")]).toEqual([c, true]);
      if (c.startsWith("t-mono")) expect([c, rule?.includes("font-variant-numeric:tabular-nums slashed-zero")]).toEqual([c, true]);
    }
    for (const c of MARK_CLASSES) expect([c, ruleOf(`.${c}`) !== undefined]).toEqual([c, true]);
  });

  test("nothing external: no @import, and no url( but data: and the hatch pattern", () => {
    expect(css).not.toContain("@import");
    const urls = css.match(/url\([^)]*\)/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect([u, u.startsWith("url(data:") || u === "url(#kit-hatch)"]).toEqual([u, true]);
  });

  test("determinism: two calls give identical strings", () => {
    expect(kitCss({ footerLeft: "Your practice · No. 0000-0000" })).toBe(css);
  });

  test("a hostile footer cannot close the style element or break out of its string", () => {
    const hostile = kitCss({ footerLeft: 'x"}</style><script>alert(1)</script>\n' });
    expect(hostile).not.toContain("</style");
    expect(hostile).not.toContain("<script");
    expect(hostile).toContain(`@bottom-left{content:${cssString('x"}</style><script>alert(1)</script>\n')}`);
  });
});

describe("cssString", () => {
  test("quotes, backslashes and newlines are escaped (pre-flight F6)", () => {
    expect(cssString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\A d"');
  });

  test("< and > become hex escapes, so no raw </style> (pre-flight F6)", () => {
    expect(cssString("</style>")).toBe('"\\3C /style\\3E "');
  });

  test("other control characters are dropped; ordinary text is kept", () => {
    expect(cssString("a\u0000b\tc\rd\u001Fe\u007Ff\u0085g")).toBe('"abcdefg"');
    expect(cssString("Jordan Example · No. 7F3A-91C2")).toBe('"Jordan Example · No. 7F3A-91C2"');
  });
});
