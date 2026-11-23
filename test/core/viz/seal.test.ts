import { describe, expect, test } from "bun:test";
import { auditHtml } from "../../../core/viz/audit";
import { KIT_CLASSES } from "../../../core/viz/css";
import { page } from "../../../core/viz/page";
import { seal, sealSvg } from "../../../core/viz/seal";
import type { SealInput } from "../../../core/viz/types";

const S: SealInput = { state: "struck", label: "Strong", score: 71, interval: [63, 78], coverage: "6/7 dimensions",
  ringText: "AI practice report · No. 7F3A-91C2 · 18 Nov 2026" };
const svgOf = (html: string): string => html.slice(html.indexOf("<svg"), html.indexOf("</svg>") + "</svg>".length);

describe("seal", () => {
  test("struck: seal--struck and a filled disc; the numerals are plain text", () => {
    const out = seal(S);
    expect(out).toContain("seal--struck");
    expect(out).toContain('<circle class="seal-disc" cx="96" cy="96" r="80"/>');
    expect(out).toContain('class="seal-text t-mono-64"');
    expect(out).not.toContain("seal-outline");
  });

  test("the rings: outer r 94 at 1.5, inner r 80 at 0.75", () => {
    const out = sealSvg(S);
    expect(out).toContain('<circle class="seal-ring" cx="96" cy="96" r="94" stroke-width="1.5"/>');
    expect(out).toContain('<circle class="seal-ring" cx="96" cy="96" r="80" stroke-width="0.75"/>');
  });

  test("provisional: no disc fill and outlined numerals", () => {
    const out = seal({ ...S, state: "provisional", score: 52, interval: null, label: "Provisional" });
    expect(out).toContain("seal--provisional");
    expect(out).not.toContain("seal--struck");
    expect(out).toContain('class="seal-outline t-mono-64"');
  });

  test("flagged: the vermilion state class", () => {
    const out = seal({ ...S, state: "flagged", label: "Check data" });
    expect(out).toContain("seal--flagged");
    expect(out).not.toContain("seal--struck");
  });

  test("a null score draws a short solid hairline in place of the numerals, in every state", () => {
    for (const state of ["struck", "provisional", "flagged"] as const) {
      const out = sealSvg({ ...S, state, score: null });
      expect([state, out.includes('<path class="seal-dash" d="M80 88H112"/>'), out.includes("t-mono-64")]).toEqual([state, true, false]);
    }
    expect(sealSvg(S)).not.toContain("seal-dash");
  });

  test("the interval and the coverage are HTML after the </svg>, never SVG text", () => {
    const out = seal(S);
    const end = out.indexOf("</svg>");
    expect(svgOf(out)).not.toContain("[63–78]");
    expect(svgOf(out)).not.toContain("6/7");
    expect(out.indexOf("[63–78]")).toBeGreaterThan(end);
    expect(out.indexOf("6/7 dimensions")).toBeGreaterThan(end);
    expect(out).toContain('<div class="seal__meta"><span class="t-mono-14 seal__interval">[63–78]</span><span class="t-mono-12">6/7 dimensions</span></div>');
  });

  test("no interval: only the coverage", () => {
    expect(seal({ ...S, interval: null })).toContain('<div class="seal__meta"><span class="t-mono-12">6/7 dimensions</span></div>');
  });

  test("the ring text runs on a path at r 87 and is escaped, as are the label and coverage", () => {
    const out = seal({ ...S, ringText: "<script>x</script>", label: "<b>", coverage: "a&b" });
    expect(out).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(out).toContain("&lt;b&gt;");
    expect(out).toContain("a&amp;b");
    expect(out).not.toContain("<script>");
  });

  test("ring text: two arcs with caps centred on r 87, both reading left to right; the part after the last ' · ' goes on the bottom", () => {
    const out = sealSvg(S);
    // Baselines at 87 ∓ half the cap height (4.38): 82.62 on the top arc, where glyphs point out; 91.38 underneath.
    expect(out).toContain('<path id="seal-ringtop" d="M24.45 137.31A82.62 82.62 0 1 1 167.55 137.31"/>');
    expect(out).toContain('<path id="seal-ringbottom" d="M16.86 141.69A91.38 91.38 0 0 0 175.14 141.69"/>');
    expect(out).toContain('<textPath href="#seal-ringtop" startOffset="50%">AI practice report · No. 7F3A-91C2</textPath>');
    expect(out).toContain('<textPath href="#seal-ringbottom" startOffset="50%">18 Nov 2026</textPath>');
    expect(out).not.toContain("textLength");
  });

  test("ring text with no separator: the top arc only", () => {
    const out = sealSvg({ ...S, ringText: "AI practice report" });
    expect(out).toContain(">AI practice report</textPath>");
    expect(out).not.toContain("ringbottom");
  });

  test("ring text too long for its arc is fitted to the arc, never cut or run past it", () => {
    const out = sealSvg({ ...S, ringText: "A very long practice report title that runs on and on · a long bottom line here" });
    expect(out).toContain('textLength="311.47" lengthAdjust="spacingAndGlyphs"');
    expect(out).toContain('textLength="172.25" lengthAdjust="spacingAndGlyphs"');
  });

  test("sealSvg is the seal's <svg> alone, and seal() holds it unchanged", () => {
    for (const state of ["struck", "provisional", "flagged"] as const) {
      const s = sealSvg({ ...S, state });
      expect(s.startsWith("<svg ")).toBe(true);
      expect(s.endsWith("</svg>")).toBe(true);
      const tags = new Set([...s.matchAll(/<([a-zA-Z]+)/g)].map((m) => m[1]!));
      expect([...tags].filter((t) => !["svg", "defs", "path", "circle", "text", "textPath"].includes(t))).toEqual([]);
      expect(seal({ ...S, state })).toContain(s);
    }
  });

  test("idPrefix names the ring path, so two seals on one page do not share an id", () => {
    const a = sealSvg(S, { idPrefix: "card" });
    expect(a).toContain('id="card-ringtop"');
    expect(a).toContain('href="#card-ringbottom"');
    expect(seal(S, { idPrefix: "you" })).toContain(sealSvg(S, { idPrefix: "you" }));
  });

  test("size sets the svg's width and height; the viewBox stays 192", () => {
    expect(sealSvg(S, { size: 144 })).toContain('viewBox="0 0 192 192" width="144" height="144"');
    expect(sealSvg(S)).toContain('viewBox="0 0 192 192" width="192" height="192"');
  });

  test("an image with its reading", () => {
    expect(sealSvg(S)).toContain('role="img" aria-label="Strong, 71"');
    expect(sealSvg({ ...S, score: null, label: "Provisional" })).toContain('aria-label="Provisional, no score"');
  });

  test("every class is a kit class, and the page is clean", () => {
    const body = "<main>" + seal(S, { idPrefix: "s1" }) + seal({ ...S, state: "provisional", score: null }, { idPrefix: "s2" })
      + seal({ ...S, state: "flagged" }, { idPrefix: "s3" }) + "</main>";
    const used = new Set([...body.matchAll(/ class="([^"]*)"/g)].flatMap((m) => m[1]!.split(" ")));
    expect([...used].filter((c) => !KIT_CLASSES.includes(c))).toEqual([]);
    const a = auditHtml(page({ title: "t", footerLeft: "f", body, fonts: "none" }));
    expect([a.nonCanonical, a.styleAttrs, a.inlineHandlers, a.externalRefs, a.uncovered]).toEqual([[], 0, 0, [], []]);
  });

  test("two seals with the default prefix share ids, and the audit says so", () => {
    const a = auditHtml(page({ title: "t", footerLeft: "f", body: "<main>" + seal(S) + seal(S) + "</main>", fonts: "none" }));
    expect(a.nonCanonical.some((f) => f.startsWith("duplicate-id"))).toBe(true);
  });
});
