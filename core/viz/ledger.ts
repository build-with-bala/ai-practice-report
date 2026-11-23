import { fmt } from "./fmt";
import { attr, capsText, cite, esc } from "./html";
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

/** A scored row's values as drawn and printed: the score rounded and clamped, the interval sorted, rounded and clamped. */
interface Resolved { score: number; interval: readonly [number, number] | null }

/**
 * The one place a row's numbers are fixed, so the mark and the text always agree: a score of 70.6 prints "71" and sits
 * at x(71); `[78, 63]` reads 63–78. Null for a row that is not scored; a scored row without a finite score throws.
 */
function resolve(r: LedgerRow): Resolved | null {
  if (r.status !== "scored") return null;
  if (r.score === null || !Number.isFinite(r.score)) throw new Error(`ledger: row "${r.id}" is scored but has no finite score`);
  const fix = (v: number): number => Math.round(clamp(v));
  const iv = r.interval === null ? null : ([fix(Math.min(...r.interval)), fix(Math.max(...r.interval))] as const);
  return { score: fix(r.score), interval: iv };
}

/** One row's rule as a nested `<svg viewBox="0 0 400 24">`, pure SVG; `ledger()` and the share card both use it (pre-flight F15). */
export function ledgerRuleSvg(row: LedgerRow, o: { x?: number; y?: number; width?: number } = {}): string {
  const v = resolve(row);
  const place = (o.x === undefined ? "" : attr("x", n(o.x))) + (o.y === undefined ? "" : attr("y", n(o.y)))
    + (o.width === undefined ? "" : attr("width", n(o.width)) + attr("height", n((o.width * 24) / 400)));
  let marks = `<path class="m-axis" d="${AXIS}"/>${REF}`;
  if (v === null) {
    marks += HATCH;
  } else {
    if (v.interval !== null) {
      const lo = n(x(v.interval[0]));
      const hi = n(x(v.interval[1]));
      marks += `<path class="m-solid m-stroke" stroke-width="2" d="M${lo} 12H${hi}M${lo} 8V16M${hi} 8V16"/>`;
    }
    const cx = x(v.score);
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

type Unscored = Exclude<LedgerRow["status"], "scored">;
/** An unscored row's explanation: its note, or its status said plainly. */
const noteOf = (r: LedgerRow): string => r.note ?? STATUS_TEXT[r.status as Unscored];

/** The row's reading as text: "Leverage 71, interval 63 to 78, high confidence"; for an unscored row, "Label, <note>". */
function reading(r: LedgerRow, v: Resolved | null): string {
  if (v === null) return `${r.label}, ${noteOf(r)}`;
  const parts = [`${r.label} ${fmt.score(v.score)}`];
  if (v.interval !== null) parts.push(`interval ${fmt.score(v.interval[0])} to ${fmt.score(v.interval[1])}${r.openTail ? " or above" : ""}`);
  if (r.confidence !== null) parts.push(`${r.confidence} confidence`);
  return parts.join(", ");
}

/**
 * An unscored row's short value token: `n=12/60` when its note carries the kit's "n=<count>, needs <count>" wording,
 * else `—`. The full note goes on its own line under the rule and into the row's accessible name.
 */
function unscoredToken(note: string): string {
  const m = note.match(/\bn=([\d,]+), needs ([\d,]+)/);
  return m ? `n=${m[1]}/${m[2]}` : "—";
}

/** An exhibit id's cite label: `ex-c` → `Ex. C`; any other id is its own label. */
const citeLabel = (id: string): string => (/^ex-[a-z]$/.test(id) ? `Ex. ${id.slice(3).toUpperCase()}` : id);

/** One component row. `data-label` names the cell when the table stacks below 640 px (kit CSS). */
function componentRow(c: LedgerComponent): string {
  const value = c.status === "ok" ? c.value : STATUS_TEXT[c.status];
  const cites = (c.cites ?? []).map((id) => cite(id, citeLabel(id))).join(" ");
  return "<tr>"
    + `<td>${esc(c.label)}</td>`
    + `<td class="num" data-label="weight">${esc(fmt.share(c.weight))}</td>`
    + `<td class="num">${esc(value)}</td>`
    + `<td class="num" data-label="z">${esc(c.z === null ? "—" : fmt.signed(c.z))}</td>`
    + `<td class="num" data-label="n">${esc(fmt.count(c.n))}</td>`
    + `<td>${cites}</td>`
    + "</tr>";
}

function componentsTable(r: LedgerRow): string {
  return '<div class="ledger-components"><table><thead><tr><th>Component</th><th class="num">Weight</th><th class="num">Value</th>'
    + '<th class="num">z</th><th class="num">n</th><th>Evidence</th></tr></thead><tbody>'
    + r.components.map(componentRow).join("") + "</tbody></table></div>";
}

const WINDOW: Readonly<Record<LedgerRow["window"], string>> = { detail: "Detail", lifetime: "Lifetime" };

/**
 * One row. With components it is a `<details>` whose `<summary>` is the line; with none it is a plain `div` with a
 * `role="group"` line, so no keyboard stop discloses nothing.
 */
function ledgerRow(r: LedgerRow, idPrefix: string): string {
  const v = resolve(r);
  const cls = v === null ? "ledger-row ledger-row--unscored" : "ledger-row";
  const value = v === null
    ? `<span class="ledger-row__value t-mono-14 c-muted">${esc(unscoredToken(noteOf(r)))}</span>`
    : `<span class="ledger-row__value"><span class="t-mono-16">${esc(fmt.score(v.score))}</span>`
      + (v.interval === null ? "" : ` <span class="t-mono-14 ledger-row__interval">${esc(fmt.interval(v.interval))}</span>`) + "</span>";
  const dots = v === null ? "" : `<span class="ledger-row__dots">${confidenceDots(r.confidence)}</span>`;
  const note = v === null ? `<span class="ledger-row__note t-mono-14">${esc(noteOf(r))}</span>` : "";
  const line = `<span class="ledger-row__label t-mono-14">${esc(r.label)}</span>`
    + `<span class="ledger-row__rule">${ledgerRuleSvg(r)}</span>`
    + value + dots
    + `<span class="ledger-row__window tag">${WINDOW[r.window]}</span>`
    + note;
  const label = attr("aria-label", reading(r, v));
  if (r.components.length === 0) {
    return `<div${attr("class", cls)}${attr("id", idPrefix + r.id)}><div class="ledger-row__line" role="group"${label}>${line}</div></div>`;
  }
  return `<details${attr("class", cls)}${attr("id", idPrefix + r.id)}><summary${label}>${line}</summary>${componentsTable(r)}</details>`;
}

/** The assay ledger: each group a labelled section of rows; row ids are `idPrefix + row.id` (default `ledger-`). */
export function ledger(groups: readonly LedgerGroup[], o: { idPrefix?: string } = {}): string {
  const idPrefix = o.idPrefix ?? "ledger-";
  return '<div class="ledger">' + groups.map((g) => '<section class="ledger-group">'
    + `<h3 class="tag">${capsText(g.label)}</h3>` + g.rows.map((r) => ledgerRow(r, idPrefix)).join("") + "</section>").join("") + "</div>";
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
