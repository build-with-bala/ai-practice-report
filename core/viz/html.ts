import { coveredBy } from "./fonts";

const ESC: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text or an attribute value made safe for HTML: `& < > " '` become entities. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]!);
}

/** The attribute names the audit's canonical subset accepts. */
const ATTR_NAME = /^[A-Za-z][A-Za-z0-9:-]*$/;

/** One attribute, with its leading space: ` name="<escaped value>"`. Throws on a name outside `[A-Za-z][A-Za-z0-9:-]*`. */
export function attr(name: string, value: string): string {
  if (!ATTR_NAME.test(name)) throw new Error("attr: the attribute name is not [A-Za-z][A-Za-z0-9:-]*");
  return ` ${name}="${esc(value)}"`;
}

/**
 * A cite: the canonical markup the runtime's cite handling expects, `<button type="button" class="cite" data-cite="<id>"
 * aria-pressed="false">label</button>`. Never an `<a>`: a link with `aria-pressed` is no toggle to assistive technology,
 * and a button is reached and activated by keyboard (Enter and Space) with no extra script.
 */
export function cite(id: string, label: string): string {
  return `<button type="button" class="cite"${attr("data-cite", id)} aria-pressed="false">${esc(label)}</button>`;
}

/**
 * Text for a caps role (`tag`, `t-mono-12`), escaped, with each statistical `n` before `=` wrapped in
 * `<span class="keep-case">` so it stays lower-case: `DETAIL · n=412`. Caps apply to words only.
 */
export function capsText(s: string): string {
  return esc(s).replace(/(^|[^A-Za-z0-9_])n(?==)/g, '$1<span class="keep-case">n</span>');
}

const JSON_ESC: Readonly<Record<string, string>> = { "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "\u2028": "\\u2028", "\u2029": "\\u2029" };

/**
 * A JSON data island: `<script type="application/json" id>` holding `value` as JSON, with `<`, `>`, `&`, U+2028 and
 * U+2029 written as `\u` escapes, so no `</script` or `<!--` can occur inside it and its text parses back to the value.
 * A JSON island is not executable, so the page's CSP does not pin it.
 */
export function jsonIsland(id: string, value: unknown): string {
  const json = (JSON.stringify(value) ?? "null").replace(/[<>&\u2028\u2029]/g, (c) => JSON_ESC[c]!);
  return `<script type="application/json"${attr("id", id)}>${json}</script>`;
}

/**
 * The type class for display text: `t-disp-<size>` when the display face covers every character, in the case it is set
 * (display is upper-case, so both forms are checked); otherwise mono, `t-mono-44` for an h1 name and `t-mono-20` for
 * chapter heads and exhibit titles.
 */
export function displayText(text: string, size: 20 | 28 | 44): string {
  const covered = (s: string): boolean => [...s].every((ch) => coveredBy(ch, "display"));
  if (covered(text) && covered(text.toUpperCase())) return `t-disp-${size}`;
  return size === 44 ? "t-mono-44" : "t-mono-20";
}
