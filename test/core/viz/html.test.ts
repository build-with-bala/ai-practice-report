import { describe, expect, test } from "bun:test";
import { auditHtml } from "../../../core/viz/audit";
import { attr, cite, displayText, esc, jsonIsland } from "../../../core/viz/html";
import { page } from "../../../core/viz/page";
import { icon, type IconName } from "../../../core/viz/icons";

describe("esc and attr", () => {
  test("the five HTML specials are escaped", () => {
    expect(esc(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
    expect(esc("Jordan Example · No. 7F3A")).toBe("Jordan Example · No. 7F3A");
  });

  test("attr gives a leading space, the name and the escaped, quoted value", () => {
    expect(attr("aria-label", `a"b<c`)).toBe(' aria-label="a&quot;b&lt;c"');
  });

  test("attr refuses a name outside [A-Za-z][A-Za-z0-9:-]*", () => {
    for (const ok of ["id", "data-cite", "xlink:href", "aria-pressed", "x1"]) expect(attr(ok, "v")).toBe(` ${ok}="v"`);
    for (const bad of ["", "1a", "-a", "a b", 'a"', "a=b", "a>", "a/", "\u00e9", "a\u0000", "on click", "data_cite", ":a"]) {
      expect(() => attr(bad, "v")).toThrow();
    }
  });
});

describe("cite", () => {
  test("a cite is a type=button button with data-cite and aria-pressed false, never a link", () => {
    expect(cite("ex-c", "Ex. C")).toBe('<button type="button" class="cite" data-cite="ex-c" aria-pressed="false">Ex. C</button>');
    expect(cite("ex-c", "Ex. C")).not.toContain("<a");
  });

  test("the id and the label are escaped, and a page with cites audits clean", () => {
    const out = cite('a"b', "<b>&");
    expect(out).toBe('<button type="button" class="cite" data-cite="a&quot;b" aria-pressed="false">&lt;b&gt;&amp;</button>');
    const a = auditHtml(page({ title: "t", footerLeft: "f", fonts: "none",
      body: `<main><p>See ${cite("ex-c", "Ex. C")}.</p><figure id="ex-c"><figcaption>c</figcaption></figure></main>` }));
    expect([a.cspOk, a.nonCanonical, a.externalRefs]).toEqual([true, [], []]);
  });
});

describe("jsonIsland", () => {
  test("a hostile string cannot close the script, and the island's text parses back to the value", () => {
    const value = { s: "</script><!-- ", t: "a\u2028b\u2029c&d>e" };
    const out = jsonIsland("d", value);
    expect(out.startsWith('<script type="application/json" id="d">')).toBe(true);
    expect(out.endsWith("</script>")).toBe(true);
    const inner = out.slice('<script type="application/json" id="d">'.length, -"</script>".length);
    expect(inner).not.toMatch(/<\/script/i);
    expect(inner).not.toContain("<!--");
    expect(inner).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(inner)).toEqual(value);
  });

  test("the id is escaped", () => {
    expect(jsonIsland('a"b', 1)).toBe('<script type="application/json" id="a&quot;b">1</script>');
  });
});

describe("displayText", () => {
  test("text the display face covers keeps the display class", () => {
    expect(displayText("Jordan Example", 44)).toBe("t-disp-44");
    expect(displayText("Exhibit title", 20)).toBe("t-disp-20");
    expect(displayText("Chapter", 28)).toBe("t-disp-28");
  });

  test("text the display face lacks falls back to mono", () => {
    expect(displayText("Łukasz", 44)).toBe("t-mono-44");
    expect(displayText("Łukasz", 28)).toBe("t-mono-20");
    expect(displayText("Łukasz", 20)).toBe("t-mono-20");
  });

  test("display is set in caps, so the upper-case form must be covered too", () => {
    // ÿ is Latin-1, but its capital Ÿ (U+0178) is not in the display subset.
    expect(displayText("ÿ", 44)).toBe("t-mono-44");
  });
});

describe("icon", () => {
  const NAMES: IconName[] = ["arrow", "flag", "check", "diamond", "diamond-hollow", "triangle", "dot", "ring", "square", "theme", "print"];

  test("every icon is a 12×12 inline SVG of class icon, hidden from assistive technology", () => {
    for (const n of NAMES) {
      const svg = icon(n);
      expect([n, svg.startsWith('<svg class="icon" viewBox="0 0 12 12" width="12" height="12"')]).toEqual([n, true]);
      expect([n, svg.includes('aria-hidden="true"'), svg.includes("role=")]).toEqual([n, true, false]);
      expect([n, /<path d="[^"]+"/.test(svg), svg.endsWith("</svg>")]).toEqual([n, true, true]);
      expect([n, /\b(?:fill|stroke)="#/.test(svg)]).toEqual([n, false]);
    }
    expect(new Set(NAMES.map((n) => icon(n))).size).toBe(NAMES.length);
  });

  test("a labelled icon is an image with an escaped label", () => {
    const svg = icon("flag", { label: 'a "flag" <b>' });
    expect(svg).toContain('role="img" aria-label="a &quot;flag&quot; &lt;b&gt;"');
    expect(svg).not.toContain("aria-hidden");
  });
});
