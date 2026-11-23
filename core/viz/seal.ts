import { fmt } from "./fmt";
import { attr, capsText, esc } from "./html";
import type { SealInput } from "./types";

/*
 * The struck seal (Design system, "Seal"): viewBox 192 × 192, an outer ring at r 94 (stroke 1.5) and an inner ring at
 * r 80 (stroke 0.75), the ring text at r 87, and in the centre the score (`t-mono-64`, 64 units) over the band label
 * (mono 16 caps). The interval and the coverage are HTML below the SVG, never SVG text.
 *
 * Ring text is never upside down. `ringText` is split at its last " · ": the part before it runs on the top arc (240°,
 * over the top), the part after it on the bottom arc (120°, under the disc), both reading left to right, caps centred
 * on r 87. With no
 * separator, all of it goes on the top. Text longer than 90% of its arc is fitted to that length (`textLength`), so it
 * is never cut off and never runs past the arc, at any size.
 *
 * States, as a class on the <svg>: `seal--struck` fills the inner disc and sets the centre in onAccent (and strikes once,
 * in CSS); `seal--provisional` leaves the disc open and outlines the numerals; `seal--flagged` turns rings and text
 * vermilion. A missing score is a short solid hairline (`seal-dash`) in place of the numerals, in every state.
 */

/** The separator whose last occurrence splits the ring text into its top and bottom parts. */
export const RING_SEPARATOR = " · ";

const n2 = (x: number): string => String(Math.round(x * 100) / 100);

/**
 * The ring text's caps are centred on r 87. Text sits on its alphabetic baseline (`dominant-baseline` on a textPath is
 * not honoured everywhere), so each arc's baseline is offset by half the cap height (JetBrains Mono: 0.73 em of 12):
 * inward on the top arc, where glyphs point out, and outward on the bottom arc, where they point in.
 */
const HALF_CAP = (0.73 * 12) / 2;
const TOP_R = 87 - HALF_CAP;
const BOTTOM_R = 87 + HALF_CAP;
/** A point on a circle about (96, 96) at 30° below the horizontal: left or right. */
const at = (r: number, side: -1 | 1): string => `${n2(96 + side * r * Math.cos(Math.PI / 6))} ${n2(96 + r * Math.sin(Math.PI / 6))}`;
/** Over the top, clockwise: 240°. */
const TOP_ARC = `M${at(TOP_R, -1)}A${n2(TOP_R)} ${n2(TOP_R)} 0 1 1 ${at(TOP_R, 1)}`;
/** Under the disc, anticlockwise, so glyphs stand upright: 120°. */
const BOTTOM_ARC = `M${at(BOTTOM_R, -1)}A${n2(BOTTOM_R)} ${n2(BOTTOM_R)} 0 0 0 ${at(BOTTOM_R, 1)}`;
const TOP_LENGTH = (TOP_R * 4 * Math.PI) / 3;
const BOTTOM_LENGTH = (BOTTOM_R * 2 * Math.PI) / 3;
/** The advance of one ring-text character: mono 12 at 0.6 em, plus 0.12 em tracking. */
const ADVANCE = 12 * 0.6 + 12 * 0.12;
/** Ring text may fill this share of its arc before it is fitted. */
const FILL = 0.9;

function ringPath(id: string, text: string, arcLength: number): string {
  const max = arcLength * FILL;
  const fit = [...text].length * ADVANCE > max ? `${attr("textLength", n2(max))} lengthAdjust="spacingAndGlyphs"` : "";
  return `<text class="seal-ringtext" text-anchor="middle"><textPath${attr("href", `#${id}`)} startOffset="50%"${fit}>${esc(text)}</textPath></text>`;
}

/** The seal's <svg> alone, with no HTML: `seal()` wraps it, and the share card nests it (pre-flight F15). */
export function sealSvg(s: SealInput, o: { size?: number; idPrefix?: string } = {}): string {
  const size = String(o.size ?? 192);
  const prefix = o.idPrefix ?? "seal";
  const cut = s.ringText.lastIndexOf(RING_SEPARATOR);
  const top = cut < 0 ? s.ringText : s.ringText.slice(0, cut);
  const bottom = cut < 0 ? "" : s.ringText.slice(cut + RING_SEPARATOR.length);
  const score = s.score === null || !Number.isFinite(s.score) ? null : fmt.score(s.score);
  const reading = `${s.label}, ${score ?? "no score"}`;
  const centre = score === null
    ? '<path class="seal-dash" d="M80 88H112"/>'
    : `<text${attr("class", `${s.state === "provisional" ? "seal-outline" : "seal-text"} t-mono-64`)} x="96" y="111" text-anchor="middle">${esc(score)}</text>`;
  const defs = `<path${attr("id", `${prefix}-ringtop`)} d="${TOP_ARC}"/>` + (bottom ? `<path${attr("id", `${prefix}-ringbottom`)} d="${BOTTOM_ARC}"/>` : "");
  return `<svg${attr("class", `seal--${s.state}`)} viewBox="0 0 192 192"${attr("width", size)}${attr("height", size)} role="img"${attr("aria-label", reading)}>`
    + `<defs>${defs}</defs>`
    + '<circle class="seal-disc" cx="96" cy="96" r="80"/>'
    + '<circle class="seal-ring" cx="96" cy="96" r="94" stroke-width="1.5"/>'
    + '<circle class="seal-ring" cx="96" cy="96" r="80" stroke-width="0.75"/>'
    + ringPath(`${prefix}-ringtop`, top, TOP_LENGTH)
    + (bottom ? ringPath(`${prefix}-ringbottom`, bottom, BOTTOM_LENGTH) : "")
    + centre
    + `<text class="seal-text seal-band t-mono-16" x="96" y="137" text-anchor="middle">${esc(s.label)}</text>`
    + "</svg>";
}

/**
 * The seal: its SVG, then the interval (mono 14) and the coverage (mono 12) as HTML. Its size is the kit CSS's (192 px,
 * 144 px below 640 px, 48 mm in print). Give each seal on a page its own `idPrefix`: the ring paths have ids.
 */
export function seal(s: SealInput, o: { idPrefix?: string } = {}): string {
  const iv = s.interval === null ? null : ([Math.min(...s.interval), Math.max(...s.interval)] as const);
  const interval = iv === null ? "" : `<span class="t-mono-14 seal__interval">${esc(fmt.interval(iv))}</span>`;
  return `<div class="seal">${sealSvg(s, { idPrefix: o.idPrefix })}<div class="seal__meta">${interval}<span class="t-mono-12">${capsText(s.coverage)}</span></div></div>`;
}
