import { fmt } from "./fmt";
import { attr, cite, esc } from "./html";
import type { LedgerComponent, LedgerGroup, LedgerRow } from "./types";

/*
 * The assay ledger (Design system, "Ledger row"). Each row is a `<details>` whose `<summary>` holds the reading as text
 * (its aria-label) and as columns: label (mono 14) | rule | score (mono 16) and interval (mono 14) | three confidence
 * dots | window tag (mono 12). The row's components table opens below it.
 *
 * The rule is a pure SVG, `viewBox="0 0 400 24"` with `x(s) = 8 + 3.84·s`: the axis at y 12 from x 8 to 392 with ticks
 * at 0, 25, 50, 75 and 100 (y 9–15), the reference v0 median at x(50) (y 4–20), the interval from x(lo) to x(hi) (stroke
 * 2, caps at y 8–16), the 10 × 10 ◆ at x(score) (solid at medium or high confidence, hollow at low), and the open tail,
 * a right-pointing triangle at x 392–400. A row that is not scored gets a hatched rect over x 8–392, y 8–16, and no ◆.
 * Every mark of one class is one <path> (builder's call 4).
 */

/** A number as SVG coordinate text: at most two decimals, no trailing zeros, no `-0`. */
const n = (x: number): string => String(Math.round(x * 100) / 100 + 0);
const clamp = (s: number): number => Math.min(100, Math.max(0, s));
/** The rule's x of a score. */
const x = (s: number): number => 8 + 3.84 * clamp(s);

const AXIS = "M8 12H392" + [0, 25, 50, 75, 100].map((s) => `M${n(x(s))} 9V15`).join("");
const REF = `<path class="m-ref" d="M${n(x(50))} 4V20"/>`;
const TAIL = '<path class="m-solid" d="M392 8L400 12L392 16Z"/>';
const HATCH = '<rect class="m-hatch" x="8" y="8" width="384" height="8"/>';

const scored = (r: LedgerRow): r is LedgerRow & { score: number } => r.status === "scored" && r.score !== null && Number.isFinite(r.score);

/** One row's rule as a nested `<svg viewBox="0 0 400 24">`, pure SVG; `ledger()` and the share card both use it (pre-flight F15). */
export function ledgerRuleSvg(row: LedgerRow, o: { x?: number; y?: number; width?: number } = {}): string {
  const place = (o.x === undefined ? "" : attr("x", n(o.x))) + (o.y === undefined ? "" : attr("y", n(o.y)))
    + (o.width === undefined ? "" : attr("width", n(o.width)) + attr("height", n((o.width * 24) / 400)));
  let marks = `<path class="m-axis" d="${AXIS}"/>${REF}`;
  if (!scored(row)) {
    marks += HATCH;
  } else {
    if (row.interval !== null) {
      const lo = n(x(Math.min(row.interval[0], row.interval[1])));
      const hi = n(x(Math.max(row.interval[0], row.interval[1])));
      marks += `<path class="m-solid m-stroke" stroke-width="2" d="M${lo} 12H${hi}M${lo} 8V16M${hi} 8V16"/>`;
    }
    const cx = x(row.score);
    const mark = row.confidence === "low" ? "m-hollow" : "m-solid";
    marks += `<path class="${mark}" d="M${n(cx)} 7L${n(cx + 5)} 12L${n(cx)} 17L${n(cx - 5)} 12Z"/>`;
    if (row.openTail) marks += TAIL;
  }
  return `<svg viewBox="0 0 400 24"${place} aria-hidden="true" focusable="false">${marks}</svg>`;
}

const FILLED: Readonly<Record<NonNullable<LedgerRow["confidence"]>, number>> = { low: 1, medium: 2, high: 3 };
/** Dot centres on a 30 × 8 grid. */
const DOT_X = [4, 15, 26] as const;

/** Three dots, `filled` of them solid and the rest axis rings, as one path per class. */
function dotsSvg(filled: number, a11y: string): string {
  const solid = DOT_X.slice(0, filled).map((cx) => `M${cx - 3} 4a3 3 0 1 0 6 0a3 3 0 1 0-6 0`).join("");
  const ring = DOT_X.slice(filled).map((cx) => `M${cx - 2.5} 4a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0`).join("");
  return `<svg viewBox="0 0 30 8" width="30" height="8"${a11y} focusable="false">`
    + (solid ? `<path class="m-solid" d="${solid}"/>` : "") + (ring ? `<path class="m-axis" d="${ring}"/>` : "") + "</svg>";
}

/** The three confidence dots: high fills three, medium two, low one, none fills none. An image with its reading. */
export function confidenceDots(c: LedgerRow["confidence"]): string {
  return dotsSvg(c === null ? 0 : FILLED[c], ` role="img"${attr("aria-label", c === null ? "no confidence rating" : `${c} confidence`)}`);
}

/** What an unscored row or component says when it has no note. */
const STATUS_TEXT: Readonly<Record<Exclude<LedgerRow["status"], "scored"> | Exclude<LedgerComponent["status"], "ok">, string>> = {
  insufficient: "insufficient data",
  "not-measurable": "not measurable here",
  "not-measured": "not measured",
};

/** The row's reading as text: "Leverage 71, interval 63 to 78, high confidence". */
function reading(r: LedgerRow): string {
  if (!scored(r)) return `${r.label}, ${r.note ?? STATUS_TEXT[r.status as Exclude<LedgerRow["status"], "scored">]}`;
  const parts = [`${r.label} ${fmt.score(r.score)}`];
  if (r.interval !== null) parts.push(`interval ${fmt.score(r.interval[0])} to ${fmt.score(r.interval[1])}${r.openTail ? " or above" : ""}`);
  if (r.confidence !== null) parts.push(`${r.confidence} confidence`);
  return parts.join(", ");
}

/** An exhibit id's cite label: `ex-c` → `Ex. C`; any other id is its own label. */
const citeLabel = (id: string): string => (/^ex-[a-z]$/.test(id) ? `Ex. ${id.slice(3).toUpperCase()}` : id);

function componentRow(c: LedgerComponent): string {
  const value = c.status === "ok" ? c.value : STATUS_TEXT[c.status];
  const cites = (c.cites ?? []).map((id) => cite(id, citeLabel(id))).join(" ");
  return "<tr>"
    + `<td>${esc(c.label)}</td>`
    + `<td class="num">${esc(fmt.share(c.weight))}</td>`
    + `<td class="num">${esc(value)}</td>`
    + `<td class="num">${esc(c.z === null ? "—" : fmt.signed(c.z))}</td>`
    + `<td class="num">${esc(fmt.count(c.n))}</td>`
    + `<td>${cites}</td>`
    + "</tr>";
}

function componentsTable(r: LedgerRow): string {
  if (r.components.length === 0) return "";
  return '<div class="ledger-components"><table><thead><tr><th>Component</th><th class="num">Weight</th><th class="num">Value</th>'
    + '<th class="num">z</th><th class="num">n</th><th>Evidence</th></tr></thead><tbody>'
    + r.components.map(componentRow).join("") + "</tbody></table></div>";
}

const WINDOW: Readonly<Record<LedgerRow["window"], string>> = { detail: "Detail", lifetime: "Lifetime" };

function ledgerRow(r: LedgerRow, idPrefix: string): string {
  const isScored = scored(r);
  const value = isScored
    ? `<span class="ledger-row__value"><span class="t-mono-16">${esc(fmt.score(r.score))}</span>`
      + (r.interval === null ? "" : ` <span class="t-mono-14 ledger-row__interval">${esc(fmt.interval(r.interval))}</span>`) + "</span>"
    : `<span class="ledger-row__value ledger-row__note t-mono-14">${esc(r.note ?? STATUS_TEXT[r.status as Exclude<LedgerRow["status"], "scored">])}</span>`;
  const dots = isScored ? `<span class="ledger-row__dots">${confidenceDots(r.confidence)}</span>` : "";
  return `<details${attr("class", isScored ? "ledger-row" : "ledger-row ledger-row--unscored")}${attr("id", idPrefix + r.id)}>`
    + `<summary${attr("aria-label", reading(r))}>`
    + `<span class="ledger-row__label t-mono-14">${esc(r.label)}</span>`
    + `<span class="ledger-row__rule">${ledgerRuleSvg(r)}</span>`
    + value + dots
    + `<span class="ledger-row__window tag">${WINDOW[r.window]}</span>`
    + "</summary>" + componentsTable(r) + "</details>";
}

/** The assay ledger: each group a labelled section of rows; row ids are `idPrefix + row.id` (default `ledger-`). */
export function ledger(groups: readonly LedgerGroup[], o: { idPrefix?: string } = {}): string {
  const idPrefix = o.idPrefix ?? "ledger-";
  return '<div class="ledger">' + groups.map((g) => '<section class="ledger-group">'
    + `<h3 class="tag">${esc(g.label)}</h3>` + g.rows.map((r) => ledgerRow(r, idPrefix)).join("") + "</section>").join("") + "</div>";
}

/** One legend mark on the 12 × 12 icon grid. */
const mark = (body: string): string => `<svg class="icon" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">${body}</svg>`;

/** The ledger's legend, every mark an SVG icon: score, thin score, interval, open tail, reference v0 median, not scored, confidence. */
export function ledgerLegend(): string {
  const items: [string, string][] = [
    [mark('<path class="m-solid" d="M6 1L11 6L6 11L1 6Z"/>'), "score"],
    [mark('<path class="m-hollow" d="M6 1.75L10.25 6L6 10.25L1.75 6Z"/>'), "score, thin evidence"],
    [mark('<path class="m-solid m-stroke" stroke-width="1.5" d="M1 6H11M1 3V9M11 3V9"/>'), "interval"],
    [mark('<path class="m-solid" d="M3 2L11 6L3 10Z"/>'), "open tail"],
    [mark('<path class="m-ref" d="M6 0V12"/>'), "reference v0 median"],
    [mark('<rect class="m-hatch" x="0" y="3" width="12" height="6"/>'), "not scored"],
    [dotsSvg(2, ' aria-hidden="true"'), "confidence"],
  ];
  return '<p class="ledger-legend">' + items.map(([icon, label]) => `<span>${icon}${label}</span>`).join("") + "</p>";
}
