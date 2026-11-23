import { describe, expect, test } from "bun:test";
import { auditHtml } from "../../../core/viz/audit";
import { KIT_CLASSES } from "../../../core/viz/css";
import { figure } from "../../../core/viz/figure";
import { displayText } from "../../../core/viz/html";
import { ledger } from "../../../core/viz/ledger";
import { page } from "../../../core/viz/page";
import { seal } from "../../../core/viz/seal";
import type { FigureOptions } from "../../../core/viz/types";

const F: FigureOptions = { id: "ex-c", letter: "C", title: "Verification loop", tag: "Detail · n=412", caption: "Most agent edits are checked by a test run.",
  body: '<p class="t-serif-16">body</p>' };

describe("figure", () => {
  const out = figure(F);

  test("the frame: figure.exhibit labelled by its title, a header with Ex. C, the title and the tag", () => {
    expect(out.startsWith('<figure class="exhibit" id="ex-c" aria-labelledby="ex-c-t">')).toBe(true);
    expect(out).toContain('<header class="exhibit__head"><span class="exhibit__letter t-mono-12">Ex. C</span>'
      + `<h3 class="${displayText("Verification loop", 20)}" id="ex-c-t">Verification loop</h3>`
      + '<span class="exhibit__tag t-mono-12">Detail · n=412</span></header>');
    expect(out.endsWith("</figure>")).toBe(true);
  });

  test("the body, then exactly one figcaption", () => {
    expect(out).toContain('</header><p class="t-serif-16">body</p><figcaption>Most agent edits are checked by a test run.</figcaption></figure>');
    expect(out.match(/<figcaption>/g)?.length).toBe(1);
  });

  test("a title the display face cannot set falls back to mono", () => {
    expect(figure({ ...F, title: "Łódź" })).toContain(`<h3 class="${displayText("Łódź", 20)}"`);
  });

  test("thin: exhibit--thin and the note before the body", () => {
    const thin = figure({ ...F, state: "thin", note: "thin evidence: n=9" });
    expect(thin).toContain('class="exhibit exhibit--thin"');
    expect(thin).toContain('</header><p class="exhibit__note t-mono-14">thin evidence: n=9</p><p class="t-serif-16">body</p>');
  });

  test("empty: exhibit--empty, a hatched 48-unit placeholder and the note, in place of the body", () => {
    const empty = figure({ ...F, state: "empty", note: "not enough data yet: n=3, needs 20" });
    expect(empty).toContain('class="exhibit exhibit--empty"');
    expect(empty).toContain('<svg class="exhibit__placeholder" height="48" aria-hidden="true" focusable="false"><rect class="m-hatch" width="100%" height="48"/></svg>');
    expect(empty).toContain('<p class="exhibit__note t-mono-14">not enough data yet: n=3, needs 20</p>');
    expect(empty).not.toContain("body</p>");
    expect(empty.match(/<figcaption>/g)?.length).toBe(1);
  });

  test("empty with no note: the default note", () => {
    expect(figure({ ...F, state: "empty" })).toContain(">not enough data yet</p>");
  });

  test("text is escaped; the body is HTML and passes through", () => {
    const h = figure({ ...F, id: 'ex-"x', letter: "<", title: "<t>", tag: "&", caption: "<c>", note: "<n>", state: "thin" });
    for (const s of ["&lt;t&gt;", "&amp;", "&lt;c&gt;", "&lt;n&gt;", 'id="ex-&quot;x"', 'aria-labelledby="ex-&quot;x-t"', "Ex. &lt;"]) {
      expect([s, h.includes(s)]).toEqual([s, true]);
    }
  });

  test("every class is a kit class", () => {
    const all = figure(F) + figure({ ...F, state: "thin", note: "n" }) + figure({ ...F, state: "empty" });
    const used = new Set([...all.matchAll(/ class="([^"]*)"/g)].flatMap((m) => m[1]!.split(" ")));
    expect([...used].filter((c) => !KIT_CLASSES.includes(c))).toEqual([]);
  });
});

describe("audit: all primitives on one page", () => {
  test("clean: no style attributes, no external refs, nothing uncovered, canonical", () => {
    const body = "<main>"
      + figure({ ...F, body: ledger([{ label: "Working with agents", rows: [{ id: "l", label: "Leverage", status: "scored", score: 71,
        interval: [63, 78], openTail: false, confidence: "high", window: "detail", components: [{ id: "p", label: "Parallel", weight: 1, status: "ok",
          value: "2.4", z: 1.2, n: 48, cites: ["ex-c"] }] }] }]) })
      + figure({ ...F, id: "ex-d", state: "thin", note: "thin evidence" })
      + figure({ ...F, id: "ex-e", state: "empty", note: "not enough data yet: n=3, needs 20" })
      + seal({ state: "struck", label: "Strong", score: 71, interval: [63, 78], coverage: "6/7 dimensions", ringText: "AI practice report" })
      + "</main>";
    const a = auditHtml(page({ title: "t", footerLeft: "f", body, fonts: "none" }));
    expect([a.nonCanonical, a.styleAttrs, a.inlineHandlers, a.externalRefs, a.uncovered]).toEqual([[], 0, 0, [], []]);
  });
});
