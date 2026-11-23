import { describe, expect, test } from "bun:test";
import { auditHtml } from "../../../core/viz/audit";
import { KIT_CLASSES } from "../../../core/viz/css";
import { fmt } from "../../../core/viz/fmt";
import { cite } from "../../../core/viz/html";
import { confidenceDots, ledger, ledgerLegend, ledgerRuleSvg } from "../../../core/viz/ledger";
import { page } from "../../../core/viz/page";
import type { LedgerComponent, LedgerGroup, LedgerRow } from "../../../core/viz/types";

const comp = (o: Partial<LedgerComponent> & { id: string }): LedgerComponent =>
  ({ label: o.id, weight: 0.5, status: "ok", value: "42%", z: 0.4, n: 120, ...o });

const row = (o: Partial<LedgerRow> = {}): LedgerRow => ({
  id: "leverage", label: "Leverage", status: "scored", score: 71, interval: [63, 78], openTail: false, confidence: "high",
  window: "detail",
  components: [
    comp({ id: "parallel", label: "Parallel sessions", weight: 0.6, value: "2.4 at once", z: 1.234, n: 48, cites: ["ex-a", "ex-b"] }),
    comp({ id: "delegation", label: "Delegated actions", weight: 0.4, value: "31%", z: -0.5, n: 600, cites: ["ex-b"] }),
  ],
  ...o,
});

/** The value of one attribute on the first element whose class list holds `cls`, inside `html`. */
const elementsOf = (html: string, cls: string): string[] =>
  [...html.matchAll(/<[a-zA-Z]+ [^>]*>/g)].map((m) => m[0]).filter((t) => (t.match(/ class="([^"]*)"/)?.[1] ?? "").split(" ").includes(cls));

describe("ledgerRuleSvg", () => {
  const svg = ledgerRuleSvg(row());

  test("a scored row, high confidence: one solid diamond at x(71), the interval, five ticks and the reference at x 200", () => {
    expect(svg.startsWith('<svg viewBox="0 0 400 24"')).toBe(true);
    const solids = elementsOf(svg, "m-solid").filter((t) => !t.includes("m-stroke"));
    expect(solids).toEqual(['<path class="m-solid" d="M280.64 7L285.64 12L280.64 17L275.64 12Z"/>']);
    expect(elementsOf(svg, "m-hollow")).toEqual([]);
    expect(svg).toContain('<path class="m-solid m-stroke" stroke-width="2" d="M249.92 12H307.52M249.92 8V16M307.52 8V16"/>');
    const axis = elementsOf(svg, "m-axis");
    expect(axis.length).toBe(1);
    expect(axis[0]).toContain("M8 12H392");
    expect(axis[0]!.match(/M[\d.]+ 9V15/g)).toEqual(["M8 9V15", "M104 9V15", "M200 9V15", "M296 9V15", "M392 9V15"]);
    expect(elementsOf(svg, "m-ref")).toEqual(['<path class="m-ref" d="M200 4V20"/>']);
    expect(svg).not.toContain("m-hatch");
  });

  test("low confidence: a hollow diamond, no solid one", () => {
    const low = ledgerRuleSvg(row({ confidence: "low" }));
    expect(elementsOf(low, "m-hollow")).toEqual(['<path class="m-hollow" d="M280.64 7L285.64 12L280.64 17L275.64 12Z"/>']);
    expect(elementsOf(low, "m-solid").filter((t) => !t.includes("m-stroke"))).toEqual([]);
  });

  test("open tail: a right-pointing triangle beyond x 392", () => {
    const open = ledgerRuleSvg(row({ score: 97, interval: [90, 100], openTail: true }));
    expect(open).toContain('<path class="m-solid" d="M392 8L400 12L392 16Z"/>');
    expect(ledgerRuleSvg(row())).not.toContain("M392 8L400 12L392 16Z");
  });

  test("not scored: a hatched rect over x 8–392, y 8–16, and no diamond or interval", () => {
    for (const status of ["insufficient", "not-measurable", "not-measured"] as const) {
      const s = ledgerRuleSvg(row({ status, score: null, interval: null, confidence: null }));
      expect([status, elementsOf(s, "m-hatch")]).toEqual([status, ['<rect class="m-hatch" x="8" y="8" width="384" height="8"/>']]);
      expect([status, elementsOf(s, "m-solid").length, elementsOf(s, "m-hollow").length]).toEqual([status, 0, 0]);
    }
  });

  test("scores and intervals are clamped to the scale", () => {
    const s = ledgerRuleSvg(row({ score: 104, interval: [-3, 120] }));
    expect(s).toContain("M392 7L397 12L392 17L387 12Z");
    expect(s).toContain("M8 12H392M8 8V16M392 8V16");
  });

  test("placement: x, y and width go on the nested svg; it holds no HTML element", () => {
    expect(ledgerRuleSvg(row(), { x: 10, y: 20, width: 300 }).startsWith('<svg viewBox="0 0 400 24" x="10" y="20" width="300" height="18"')).toBe(true);
    const tags = [...svg.matchAll(/<([a-zA-Z]+)/g)].map((m) => m[1]);
    expect([...new Set(tags)].sort()).toEqual(["path", "svg"]);
    expect(svg.endsWith("</svg>")).toBe(true);
  });
});

describe("confidenceDots", () => {
  const filled = (s: string): number => (elementsOf(s, "m-solid")[0]?.match(/a3 3/g)?.length ?? 0) / 2;
  const empty = (s: string): number => (elementsOf(s, "m-axis")[0]?.match(/a2\.5 2\.5/g)?.length ?? 0) / 2;

  test("high fills three dots, medium two, low one; null fills none", () => {
    expect([filled(confidenceDots("high")), empty(confidenceDots("high"))]).toEqual([3, 0]);
    expect([filled(confidenceDots("medium")), empty(confidenceDots("medium"))]).toEqual([2, 1]);
    expect([filled(confidenceDots("low")), empty(confidenceDots("low"))]).toEqual([1, 2]);
    expect([filled(confidenceDots(null)), empty(confidenceDots(null))]).toEqual([0, 3]);
  });

  test("an image with its reading", () => {
    expect(confidenceDots("high")).toContain('role="img" aria-label="high confidence"');
    expect(confidenceDots(null)).toContain('aria-label="no confidence rating"');
  });
});

describe("ledger", () => {
  const group = (rows: LedgerRow[], label = "Working with agents"): LedgerGroup => ({ label, rows });
  const one = ledger([group([row()])]);

  test("a row is a <details> whose summary holds the reading: label, rule, score, interval, dots and window", () => {
    expect(one).toContain('<details class="ledger-row" id="ledger-leverage">');
    expect(one).toContain('<summary aria-label="Leverage 71, interval 63 to 78, high confidence">');
    expect(one).toContain('<span class="ledger-row__label t-mono-14">Leverage</span>');
    expect(one).toContain('<span class="t-mono-16">71</span>');
    expect(one).toContain('<span class="t-mono-14 ledger-row__interval">[63–78]</span>');
    expect(one).toContain(confidenceDots("high"));
    expect(one).toContain('<span class="ledger-row__window tag">Detail</span>');
  });

  test("the rule is ledgerRuleSvg's output, unchanged", () => {
    expect(one).toContain(ledgerRuleSvg(row()));
  });

  test("low confidence and an open tail read as text too", () => {
    expect(ledger([group([row({ confidence: "low" })])])).toContain('aria-label="Leverage 71, interval 63 to 78, low confidence"');
    expect(ledger([group([row({ score: 97, interval: [90, 100], openTail: true })])]))
      .toContain('aria-label="Leverage 97, interval 90 to 100 or above, high confidence"');
  });

  test("insufficient with a note: the hatch, no diamond, the note in place of the score", () => {
    const note = "insufficient (n=12, needs 60) — not enough data yet";
    const out = ledger([group([row({ status: "insufficient", score: null, interval: null, confidence: null, note })])]);
    expect(out).toContain('class="m-hatch"');
    expect(out).not.toContain("L285.64 12");
    expect(out).toContain(`<span class="ledger-row__value ledger-row__note t-mono-14">${note}</span>`);
    expect(out).toContain('class="ledger-row ledger-row--unscored"');
    expect(out).toContain(`aria-label="Leverage, ${note}"`);
  });

  test("not measured: the note, no diamond", () => {
    const out = ledger([group([row({ status: "not-measured", score: null, interval: null, confidence: null, note: "not measured: no hook data" })])]);
    expect(out).toContain("not measured: no hook data");
    expect(out).not.toMatch(/class="m-(?:solid|hollow)" d=/);
  });

  test("not scored and no note: the status, said plainly", () => {
    const out = ledger([group([row({ status: "not-measurable", score: null, interval: null, confidence: null })])]);
    expect(out).toContain(">not measurable here</span>");
  });

  test("components: one table row each, z through fmt.signed, weights as shares, and their cites", () => {
    const tbody = one.slice(one.indexOf("<tbody>"), one.indexOf("</tbody>"));
    expect(tbody.match(/<tr>/g)?.length).toBe(2);
    expect(tbody).toContain(`<td class="num">${fmt.signed(1.234)}</td>`);
    expect(tbody).toContain(`<td class="num">${fmt.signed(-0.5)}</td>`);
    expect(tbody).toContain('<td class="num">60%</td>');
    expect(tbody).toContain(cite("ex-a", "Ex. A") + " " + cite("ex-b", "Ex. B"));
    expect(tbody).toContain("<td>Parallel sessions</td>");
    expect(tbody).toContain('<td class="num">2.4 at once</td>');
    expect(tbody).toContain('<td class="num">48</td>');
  });

  test("a component that is not ok shows its status, and a null z shows —", () => {
    const out = ledger([group([row({ components: [comp({ id: "c", status: "not-measurable", value: "", z: null, n: 0 })] })])]);
    expect(out).toContain('<td class="num">not measurable here</td>');
    expect(out).toContain('<td class="num">—</td>');
  });

  test("labels, notes, values and cite ids are escaped", () => {
    const out = ledger([group([row({ label: "<b>x</b>", components: [comp({ id: "c", label: "<i>y</i>", value: "a&b", cites: ['ex-"q'] })] })], "<g>")]);
    expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(out).toContain("&lt;i&gt;y&lt;/i&gt;");
    expect(out).toContain("a&amp;b");
    expect(out).toContain("&lt;g&gt;");
    expect(out).not.toContain("<b>x</b>");
    expect(out).toContain('data-cite="ex-&quot;q"');
  });

  test("idPrefix names the row ids", () => {
    expect(ledger([group([row()])], { idPrefix: "a-" })).toContain('id="a-leverage"');
  });

  test("every class it uses is a kit class", () => {
    const out = ledger([group([row(), row({ status: "insufficient", score: null, interval: null, confidence: null, note: "n" })])]) + ledgerLegend();
    const used = new Set([...out.matchAll(/ class="([^"]*)"/g)].flatMap((m) => m[1]!.split(" ")));
    expect([...used].filter((c) => !KIT_CLASSES.includes(c))).toEqual([]);
  });

  test("snapshot: three groups, seven rows", () => {
    const out = ledger([
      group([row(), row({ id: "orchestration", label: "Orchestration", score: 58, interval: [49, 66], confidence: "medium", components: [] })]),
      group([
        row({ id: "verification", label: "Verification", score: 34, interval: [22, 47], confidence: "low", window: "lifetime" }),
        row({ id: "hygiene", label: "Context hygiene", status: "insufficient", score: null, interval: null, confidence: null,
          note: "insufficient (n=12, needs 60) — not enough data yet" }),
        row({ id: "setup", label: "Setup", score: 97, interval: [90, 100], openTail: true, confidence: "high" }),
      ], "Quality · setup & judgment"),
      group([
        row({ id: "range", label: "Range", status: "not-measurable", score: null, interval: null, confidence: null, window: "lifetime" }),
        row({ id: "steady", label: "Steadiness", status: "not-measured", score: null, interval: null, confidence: null,
          note: "not measured: lifetime data only" }),
      ], "Habits"),
    ]);
    expect(out).toMatchSnapshot();
  });
});

describe("ledgerLegend", () => {
  const legend = ledgerLegend();

  test("score, interval, open tail, reference and confidence, each with an SVG mark", () => {
    for (const s of ["score", "interval", "open tail", "reference v0 median", "confidence"]) expect([s, legend.includes(s)]).toEqual([s, true]);
    expect(legend.match(/<svg /g)?.length).toBeGreaterThanOrEqual(5);
    expect(legend).not.toMatch(/[◆┆●▶]/u);
  });
});

describe("audit", () => {
  test("a page holding the ledger and its legend is clean", () => {
    const body = "<main>" + ledgerLegend() + ledger([
      { label: "A", rows: [row(), row({ id: "b", confidence: "low", openTail: true, score: 99, interval: [92, 100] })] },
      { label: "B", rows: [row({ id: "c", status: "insufficient", score: null, interval: null, confidence: null, note: "insufficient (n=12, needs 60) — not enough data yet" })] },
    ]) + "</main>";
    const a = auditHtml(page({ title: "t", footerLeft: "f", body, fonts: "none" }));
    expect([a.nonCanonical, a.styleAttrs, a.inlineHandlers, a.externalRefs, a.uncovered]).toEqual([[], 0, 0, [], []]);
  });
});
