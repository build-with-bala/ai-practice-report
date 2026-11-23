import { attr, capsText, displayText, esc } from "./html";
import type { FigureOptions } from "./types";

/** The note an empty exhibit shows when the caller gives none. */
const EMPTY_NOTE = "not enough data yet";

/** The hatched 48-unit placeholder of an empty exhibit. No viewBox: the hatch keeps its 4-unit pitch at any width. */
const PLACEHOLDER = '<svg class="exhibit__placeholder" height="48" aria-hidden="true" focusable="false"><rect class="m-hatch" width="100%" height="48"/></svg>';

/**
 * The exhibit frame: `<figure class="exhibit" id aria-labelledby>` with a header (`Ex. C` in mono 12 caps, the title as
 * an h3 through `displayText`, the tag), then the body and exactly one one-sentence `<figcaption>`.
 * - `thin`: a hollow note before the body.
 * - `empty`: the body is replaced by a hatched placeholder and the note ("not enough data yet: n=…, needs …").
 * Text fields are escaped; `body` is HTML and passes through.
 */
export function figure(o: FigureOptions): string {
  const state = o.state ?? "ok";
  const cls = state === "ok" ? "exhibit" : `exhibit exhibit--${state}`;
  const titleId = `${o.id}-t`;
  const head = '<header class="exhibit__head">'
    + `<span class="exhibit__letter t-mono-12">Ex. ${esc(o.letter)}</span>`
    + `<h3${attr("class", displayText(o.title, 20))}${attr("id", titleId)}>${esc(o.title)}</h3>`
    + `<span class="exhibit__tag t-mono-12">${capsText(o.tag)}</span>`
    + "</header>";
  const note = (text: string): string => `<p class="exhibit__note t-mono-14">${esc(text)}</p>`;
  const content = state === "empty" ? PLACEHOLDER + note(o.note ?? EMPTY_NOTE)
    : state === "thin" && o.note !== undefined ? note(o.note) + o.body
    : o.body;
  return `<figure${attr("class", cls)}${attr("id", o.id)}${attr("aria-labelledby", titleId)}>${head}${content}`
    + `<figcaption>${esc(o.caption)}</figcaption></figure>`;
}
