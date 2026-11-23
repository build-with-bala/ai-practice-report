import { coveredBy } from "./fonts";

const ESC: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text or an attribute value made safe for HTML: `& < > " '` become entities. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]!);
}

/** One attribute, with its leading space: ` name="<escaped value>"`. */
export function attr(name: string, value: string): string {
  return ` ${name}="${esc(value)}"`;
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
