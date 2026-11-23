import { fmt } from "./fmt";
import { attr, esc } from "./html";
import type { SealInput } from "./types";

/*
 * The struck seal (Design system, "Seal"): viewBox 192 × 192, an outer ring at r 94 (stroke 1.5) and an inner ring at
 * r 80 (stroke 0.75), the ring text on a circular path at r 87, and in the centre the score (`t-mono-64`, 64 units) over
 * the band label (mono 16 caps). The interval and the coverage are HTML below the SVG, never SVG text.
 *
 * States, as a class on the <svg>: `seal--struck` fills the inner disc and sets the centre in onAccent (and strikes once,
 * in CSS); `seal--provisional` leaves the disc open and outlines the numerals (a missing score's dash stays solid); `seal--flagged` turns rings and text
 * vermilion.
 */

/** The ring-text path: a circle of r 87 about (96, 96), from the bottom clockwise, so its midpoint (50%) is the top. */
const RING_PATH = "M96 183a87 87 0 1 1 0-174a87 87 0 1 1 0 174";

/** The seal's <svg> alone, with no HTML: `seal()` wraps it, and the share card nests it (pre-flight F15). */
export function sealSvg(s: SealInput, o: { size?: number; idPrefix?: string } = {}): string {
  const size = String(o.size ?? 192);
  const pathId = `${o.idPrefix ?? "seal"}-ringpath`;
  const score = s.score === null ? "—" : fmt.score(s.score);
  const reading = `${s.label}, ${s.score === null ? "no score" : score}`;
  // Provisional outlines its numerals; the dash of a missing score is no numeral, and an outlined bar reads as a box.
  const numerals = s.state === "provisional" && s.score !== null ? "seal-outline" : "seal-text";
  return `<svg${attr("class", `seal--${s.state}`)} viewBox="0 0 192 192"${attr("width", size)}${attr("height", size)} role="img"${attr("aria-label", reading)}>`
    + `<defs><path${attr("id", pathId)} d="${RING_PATH}"/></defs>`
    + '<circle class="seal-disc" cx="96" cy="96" r="80"/>'
    + '<circle class="seal-ring" cx="96" cy="96" r="94" stroke-width="1.5"/>'
    + '<circle class="seal-ring" cx="96" cy="96" r="80" stroke-width="0.75"/>'
    + `<text class="seal-ringtext" text-anchor="middle" dominant-baseline="central"><textPath${attr("href", `#${pathId}`)} startOffset="50%">${esc(s.ringText)}</textPath></text>`
    + `<text${attr("class", `${numerals} t-mono-64`)} x="96" y="111" text-anchor="middle">${esc(score)}</text>`
    + `<text class="seal-text seal-band t-mono-16" x="96" y="137" text-anchor="middle">${esc(s.label)}</text>`
    + "</svg>";
}

/** The seal: its SVG, then the interval (mono 14) and the coverage (mono 12) as HTML. */
export function seal(s: SealInput, o: { size?: number } = {}): string {
  const interval = s.interval === null ? "" : `<span class="t-mono-14 seal__interval">${esc(fmt.interval(s.interval))}</span>`;
  return `<div class="seal">${sealSvg(s, o)}<div class="seal__meta">${interval}<span class="t-mono-12">${esc(s.coverage)}</span></div></div>`;
}
