import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { auditHtml } from "../../../core/viz/audit";
import { attr, esc, jsonIsland } from "../../../core/viz/html";
import { KIT_CLASSES } from "../../../core/viz/css";
import { cspFor, page } from "../../../core/viz/page";
import { KIT_RUNTIME } from "../../../core/viz/runtime";

/** Base64 SHA-256 of a string's UTF-8 bytes, computed here, independently of the page module. */
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("base64");
const between = (html: string, open: RegExp, close: string): string => {
  const m = html.match(open)!;
  const from = m.index! + m[0].length;
  return html.slice(from, html.indexOf(close, from));
};
const styleOf = (html: string): string => between(html, /<style>/, "</style>");
const scriptOf = (html: string): string => between(html, /<script>/, "</script>");
const cspOf = (html: string): string => html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)![1]!;

const BASE = { title: "Your practice", footerLeft: "Your practice · No. 0000-0000", body: "<main id=\"main\"><h1>Hi</h1></main>", fonts: "none" } as const;

describe("cspFor", () => {
  test("exactly the pinned policy, over the exact texts", () => {
    expect(cspFor("a{}", "1")).toBe(`default-src 'none'; script-src 'sha256-${sha("1")}'; style-src 'sha256-${sha("a{}")}'; `
      + "img-src data:; font-src data:; base-uri 'none'; form-action 'none'");
  });
});

describe("page", () => {
  const out = page(BASE);

  test("the order: doctype and html, then charset, CSP, viewport, colour scheme, referrer, title and one style", () => {
    expect(out.startsWith('<!doctype html><html lang="en" data-theme="auto"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="')).toBe(true);
    const head = out.slice(0, out.indexOf("</head>"));
    const order = ["<meta charset", "Content-Security-Policy", '<meta name="viewport"', '<meta name="color-scheme" content="dark light">',
      '<meta name="referrer" content="no-referrer">', "<title>Your practice</title>", "<style>"].map((s) => head.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("the body: the hatch defs first, then the body, the print footer fallback and one script", () => {
    const body = out.slice(out.indexOf("<body>"));
    const order = ['<svg class="kit-defs"', 'id="kit-hatch"', '<main id="main">', 'class="print-footer"', "<script>"].map((s) => body.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out.endsWith("</script></body></html>")).toBe(true);
  });

  test("audit: the CSP is in place and pins the one style and the one script", () => {
    expect(auditHtml(out).cspOk).toBe(true);
  });

  test("the hashes are the base64 SHA-256 of the style and script texts", () => {
    const csp = cspOf(out);
    expect(csp).toContain(`script-src 'sha256-${sha(scriptOf(out))}'`);
    expect(csp).toContain(`style-src 'sha256-${sha(styleOf(out))}'`);
  });

  test("the style is the kit stylesheet then the extra CSS; the script is the runtime then the extra script", () => {
    const o = page({ ...BASE, css: ".x{color:red}", script: "void 0;" });
    expect(styleOf(o).endsWith(".x{color:red}")).toBe(true);
    expect(styleOf(o)).not.toContain("@font-face");
    expect(scriptOf(o).startsWith(KIT_RUNTIME)).toBe(true);
    expect(scriptOf(o).endsWith("void 0;")).toBe(true);
    expect(auditHtml(o).cspOk).toBe(true);
  });

  test("embedded fonts come first in the style", () => {
    const o = page({ ...BASE, fonts: "embed" });
    expect(styleOf(o).startsWith("@font-face{")).toBe(true);
    expect(auditHtml(o).cspOk).toBe(true);
  });

  test("a body function receives the CSP the page carries", () => {
    let seen = "";
    const o = page({ ...BASE, body: (c) => { seen = c.csp; return "<main></main>"; } });
    expect(seen).toBe(cspOf(o));
    expect(seen.startsWith("default-src 'none'")).toBe(true);
  });

  test("deterministic: two calls give identical bytes", () => {
    expect(page(BASE)).toBe(out);
  });

  test("the theme attribute: auto by default, or as given", () => {
    expect(out).toContain('<html lang="en" data-theme="auto">');
    expect(page({ ...BASE, theme: "paper" })).toContain('<html lang="en" data-theme="paper">');
    expect(page({ ...BASE, theme: "ink" })).toContain('<html lang="en" data-theme="ink">');
  });

  test("title and footer are escaped", () => {
    const o = page({ ...BASE, title: "<b>&", footerLeft: '"</div><script>' });
    expect(o).toContain("<title>&lt;b&gt;&amp;</title>");
    expect(o).toContain("&quot;&lt;/div&gt;&lt;script&gt;");
    expect(auditHtml(o).cspOk).toBe(true);
  });

  test("extra CSS or script that would close its element is refused", () => {
    expect(() => page({ ...BASE, css: "</style><script>" })).toThrow();
    expect(() => page({ ...BASE, script: "'</script>'" })).toThrow();
    expect(() => page({ ...BASE, script: "'<!--'" })).toThrow();
  });

  test("extra CSS or script holding a NUL is refused", () => {
    expect(() => page({ ...BASE, css: ".x{}\u0000" })).toThrow();
    expect(() => page({ ...BASE, script: "'\u0000'" })).toThrow();
  });

  test("a theme outside auto, ink and paper is refused: it is written before the CSP meta (review fix 2)", () => {
    expect(() => page({ ...BASE, theme: '"><script>alert(1)</script><x y="' as "auto" })).toThrow();
  });

  test("one hostile string in the title, footer, text, attribute and island leaves one style, one runtime script and one island", () => {
    const H = `</script><script>alert(1)</script><style>*{}</style><!-- "'&<img src=https://x onerror=a()>`;
    const o = page({ ...BASE, title: H, footerLeft: H, body: `<main><p${attr("title", H)}>${esc(H)}</p>${jsonIsland("d", { h: H })}</main>` });
    expect(o.match(/<script\b/gi)!.length).toBe(2);
    expect(o.match(/<script type="application\/json" id="d">/g)!.length).toBe(1);
    expect(o.match(/<style\b/gi)!.length).toBe(1);
    expect(o.match(/<img\b/gi)).toBeNull();
    const a = auditHtml(o);
    expect([a.cspOk, a.externalRefs, a.inlineHandlers, a.styleAttrs]).toEqual([true, [], 0, 0]);
  });

  test("the shell uses only kit classes", () => {
    const shell = page({ ...BASE, body: "" });
    const used = [...shell.matchAll(/\bclass="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/)).filter((c) => c !== "");
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((c) => !KIT_CLASSES.includes(c))).toEqual([]);
  });
});

describe("KIT_RUNTIME", () => {
  test("no network, no dynamic code, no HTML injection", () => {
    for (const t of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "import(", "eval", "innerHTML", "outerHTML",
      "insertAdjacentHTML", "document.write", "Function("]) {
      expect([t, KIT_RUNTIME.includes(t)]).toEqual([t, false]);
    }
  });

  test("it handles the theme toggle, print, cites and scroll boxes", () => {
    for (const t of ["aria-pressed", "localStorage", "beforeprint", "afterprint", "data-cite", "is-cited", "no-margin-boxes",
      'data-scroll="end"', "details"]) {
      expect([t, KIT_RUNTIME.includes(t)]).toEqual([t, true]);
    }
  });

  test("it is a classic script that parses", () => {
    expect(KIT_RUNTIME).not.toMatch(/^\s*(?:import|export)\s/m);
    // Parsed by the transpiler, never run.
    expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(KIT_RUNTIME)).not.toThrow();
    expect(new Bun.Transpiler({ loader: "js" }).scan(KIT_RUNTIME).imports).toEqual([]);
  });
});
