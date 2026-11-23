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
    // A missing score's dash is no numeral: it stays solid.
    expect(seal({ ...S, state: "provisional", score: null })).toContain('<text class="seal-text t-mono-64" x="96" y="111" text-anchor="middle">—</text>');
  });

  test("flagged: the vermilion state class", () => {
    const out = seal({ ...S, state: "flagged", label: "Check data" });
    expect(out).toContain("seal--flagged");
    expect(out).not.toContain("seal--struck");
  });

  test("a null score prints —", () => {
    expect(sealSvg({ ...S, score: null })).toMatch(/t-mono-64"[^>]*>—<\/text>/);
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
    expect(out).toContain('d="M96 183a87 87 0 1 1 0-174a87 87 0 1 1 0 174"');
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
    expect(a).toContain('id="card-ringpath"');
    expect(a).toContain('href="#card-ringpath"');
    expect(sealSvg(S)).toContain('id="seal-ringpath"');
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
    const body = "<main>" + seal(S) + seal({ ...S, state: "provisional", score: null }, { size: 144 }) + seal({ ...S, state: "flagged" }) + "</main>";
    const used = new Set([...body.matchAll(/ class="([^"]*)"/g)].flatMap((m) => m[1]!.split(" ")));
    expect([...used].filter((c) => !KIT_CLASSES.includes(c))).toEqual([]);
    // Each seal's ring path id is unique on a real page only with distinct prefixes; here the audit checks the markup.
    const a = auditHtml(page({ title: "t", footerLeft: "f", body, fonts: "none" }));
    expect([a.nonCanonical, a.styleAttrs, a.inlineHandlers, a.externalRefs, a.uncovered]).toEqual([[], 0, 0, [], []]);
  });
});
