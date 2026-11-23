import { uncoveredChars } from "./fonts";
import { cspFor } from "./page";

/*
 * The HTML audit: a canonical-form checker, deny by default.
 *
 * It does not imitate a browser's tokenizer. It checks that a page stays inside the small subset of HTML the kit itself
 * emits, and reports every step outside it in `nonCanonical`. The invariant: **a conforming page is read the same way by
 * browsers and by this audit**, because the subset has no construct whose parse depends on tokenizer states the audit
 * does not model (comments, CDATA, RCDATA or raw-text elements other than the three below, unquoted or odd attributes,
 * foreign content that switches parsing modes). On a page that does not conform, only `nonCanonical` is meaningful: the
 * other fields are best effort, and `cspOk` is false.
 *
 * The canonical subset:
 * 1. The document starts with `<!doctype html>`. No comment, CDATA section, processing instruction or other `<!`
 *    anywhere else.
 * 2. Start tags are `<name` with the name, case and all, in `HTML_ELEMENTS` (outside `<svg>`) or `SVG_ELEMENTS` (inside
 *    `<svg>`); `/>` only inside `<svg>`. End tags are exactly `</name>`, with a name from the same lists.
 * 3. Attributes are only ` name="value"`: separated by ASCII spaces or newlines, the name matching
 *    `[A-Za-z][A-Za-z0-9:-]*`, the value double-quoted with no raw `<`, `>` or `"`, and no name twice in a tag.
 *    `style` and `on…` attributes are counted in `styleAttrs` and `inlineHandlers`.
 * 4. URL attributes (`URL_ATTRS`) hold exactly a `#fragment`, or a `data:image/…` URL on an image (`DATA_CONTEXTS`),
 *    matched literally: no trimming and no entity decoding. `srcset` is never allowed. A violation is an external ref.
 * 5. `<meta>` is only `charset="utf-8"`, `name` viewport, color-scheme or referrer with `content`, or
 *    `http-equiv="Content-Security-Policy"` with `content`.
 * 6. Raw text only in `<style>` and `<script>` outside `<svg>`: their text holds no `<!--` and no closer but the real,
 *    exact `</style>` or `</script>`. No `<style>`, `<script>` or `<foreignObject>` inside `<svg>`. `<title>` text holds
 *    no `<`. CSS holds no backslash escape but those `cssString` writes, and its `url(…)` is exactly `#id` or a font or
 *    image `data:` URL.
 * 7. A `<` in text that does not start an allowed tag, a NUL anywhere, or anything else inside a tag is a finding.
 *
 * `nonCanonical` holds constant codes with a character offset (`<code> at <offset>`), never document text.
 */

/** The HTML elements the kit emits. A renderer that needs another one adds it here, deliberately. */
export const HTML_ELEMENTS: readonly string[] = [
  "html", "head", "meta", "title", "style", "script", "body",
  "header", "nav", "main", "footer", "section", "article", "aside", "div", "span", "p", "a",
  "h1", "h2", "h3", "h4", "ol", "ul", "li", "dl", "dt", "dd", "figure", "figcaption", "details", "summary",
  "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td", "button",
  "strong", "em", "b", "i", "small", "code", "pre", "abbr", "time", "br", "hr", "sup", "sub", "blockquote", "kbd",
  "svg",
];
/** The SVG elements the kit's icons and charts emit, allowed only inside `<svg>`. */
export const SVG_ELEMENTS: readonly string[] = [
  "svg", "g", "defs", "pattern", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textPath", "title", "desc", "use", "clipPath",
];

/** What `auditHtml` finds in a page: its size, its element count, its CSP, and whatever breaks the report rules. */
export interface Audit {
  /** UTF-8 bytes. */
  bytes: number;
  /** Start tags outside `<script>`, `<style>` and `<pre>`. */
  elements: number;
  /** The CSP meta's policy, or null. */
  csp: string | null;
  /**
   * The page is canonical (`nonCanonical` is empty), the CSP meta is the second element of `<head>`, there is one
   * `<style>` and one executable `<script>`, and the CSP pins them.
   */
  cspOk: boolean;
  /**
   * Every URL attribute (`URL_ATTRS`) that is not exactly a `#fragment` or an allowed `data:` image, as `name=value`;
   * every CSS `url(…)` that is not exactly `#id` or a font or image `data:` URL, as `url(…)`; every `@import` and
   * `image-set(`; every `<link>`, `<iframe>`, `<object>`, `<embed>` and `<base>`, as `<name>`; and every
   * `<meta http-equiv="refresh">`, as `<meta refresh>`, since CSP does not block that navigation.
   */
  externalRefs: string[];
  styleAttrs: number;
  inlineHandlers: number;
  /** Characters no embedded font covers. */
  uncovered: string[];
  /** Every step outside the canonical subset, as a constant code and an offset. Empty for a conforming page. */
  nonCanonical: string[];
}

const HTML_SET: ReadonlySet<string> = new Set(HTML_ELEMENTS);
const SVG_SET: ReadonlySet<string> = new Set(SVG_ELEMENTS);
/** The attributes whose value is a URL. */
const URL_ATTRS: ReadonlySet<string> = new Set(["href", "xlink:href", "src", "poster", "action", "formaction", "data", "ping", "background",
  "cite", "manifest", "srcset"]);
/** `element attribute` pairs where a `data:image/…` URL may stand: images, which cannot navigate. */
const DATA_CONTEXTS: ReadonlySet<string> = new Set(["img src", "image href", "image xlink:href"]);
/** SVG presentation attributes that take a CSS `url(…)`. */
const PAINT_ATTRS: ReadonlySet<string> = new Set(["fill", "stroke", "clip-path", "mask", "filter", "marker-start", "marker-mid", "marker-end", "cursor"]);
/** Elements that load or redirect something whatever their attributes say. */
const LOADERS: ReadonlySet<string> = new Set(["link", "iframe", "object", "embed", "base"]);
const META_NAMES: ReadonlySet<string> = new Set(["viewport", "color-scheme", "referrer"]);

const FRAGMENT = /^#[A-Za-z][\w:.-]*$/;
const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+(?:;base64)?,[A-Za-z0-9+/=%]*$/;
/** A canonical CSS `url(`: an id, or a woff2 font or image as base64 or percent-encoded data. */
const CSS_URL = /url\((?:#[A-Za-z][\w-]*|data:(?:font\/woff2|image\/[a-z0-9.+-]+)(?:;base64)?,[A-Za-z0-9+/=%]*)\)/y;
/** The escapes `cssString` writes: `\\`, `\"`, `\A `, `\3C ` and `\3E `. */
const CSS_ESCAPE = /\\(?:\\|"|A |3C |3E )/y;
/** One canonical attribute, read from `lastIndex`. */
const ATTR = /[ \n]+([A-Za-z][A-Za-z0-9:-]*)="([^<>"]*)"/y;
const TAG_NAME = /[A-Za-z][A-Za-z0-9]*/y;
const END_TAG = /<\/([A-Za-z][A-Za-z0-9]*)>/y;
const MAX_FINDINGS = 50;

const stickyAt = (re: RegExp, s: string, at: number): RegExpMatchArray | null => {
  re.lastIndex = at;
  return s.match(re);
};

/** Audits one report page against the report rules and the canonical subset. */
export function auditHtml(html: string): Audit {
  const nonCanonical: string[] = [];
  let dropped = 0;
  const flag = (code: string, at: number): void => {
    if (nonCanonical.length < MAX_FINDINGS) nonCanonical.push(`${code} at ${at}`);
    else dropped++;
  };
  const externalRefs: string[] = [];
  const styles: string[] = [];
  const scripts: string[] = [];
  let elements = 0;
  let styleAttrs = 0;
  let inlineHandlers = 0;
  let csp: string | null = null;
  let cspCount = 0;
  let cspAt = -1;
  let inHead = false;
  let headIndex = 0;
  let svgDepth = 0;
  let preDepth = 0;

  /** CSS checks on a style text that starts at `base`. */
  const css = (text: string, base: number): void => {
    for (const m of text.matchAll(/@import\b/gi)) externalRefs.push(`@import at ${base + m.index!}`);
    for (const m of text.matchAll(/image-set\(/gi)) externalRefs.push(`image-set( at ${base + m.index!}`);
    for (const m of text.matchAll(/url\(/gi)) {
      if (stickyAt(CSS_URL, text, m.index!) === null) externalRefs.push(`url(${text.slice(m.index! + 4, m.index! + 84).split(")")[0]})`);
    }
    for (let p = text.indexOf("\\"); p >= 0; ) {
      const e = stickyAt(CSS_ESCAPE, text, p);
      if (e === null) flag("css-escape", base + p);
      p = text.indexOf("\\", p + (e === null ? 1 : e[0].length));
    }
  };

  const nul = html.indexOf("\u0000");
  if (nul >= 0) flag("nul", nul);
  let i = 0;
  if (html.startsWith("<!doctype html>")) i = "<!doctype html>".length;
  else flag("doctype", 0);

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    const next = html[lt + 1] ?? "";

    if (next === "!" || next === "?") {
      flag("declaration", lt);
      i = lt + 2;
      continue;
    }

    if (next === "/") {
      const m = stickyAt(END_TAG, html, lt);
      const name = m?.[1];
      if (name === undefined || !(svgDepth > 0 ? SVG_SET : HTML_SET).has(name)) {
        flag("end-tag", lt);
        i = lt + 2;
        continue;
      }
      if (name === "svg" && svgDepth > 0) svgDepth--;
      else if (name === "pre" && preDepth > 0) preDepth--;
      else if (name === "head") inHead = false;
      i = lt + m![0].length;
      continue;
    }

    const nm = stickyAt(TAG_NAME, html, lt + 1);
    if (nm === null) {
      flag("raw-lt", lt);
      i = lt + 1;
      continue;
    }

    // a start tag
    const name = nm[0];
    const inSvg = svgDepth > 0;
    let j = lt + 1 + name.length;
    const attrs = new Map<string, string>();
    let selfClose = false;
    let ok = true;
    for (;;) {
      if (html[j] === ">") { j++; break; }
      if (html.startsWith("/>", j)) { selfClose = true; j += 2; break; }
      const a = stickyAt(ATTR, html, j);
      if (a === null) { ok = false; flag("attribute", j); break; }
      const key = a[1]!.toLowerCase();
      if (attrs.has(key)) flag("duplicate-attribute", j);
      else attrs.set(key, a[2]!);
      j += a[0].length;
    }

    if (name === "foreignObject") flag("foreign-object", lt);
    else if (!(inSvg ? SVG_SET : HTML_SET).has(name)) flag("element", lt);
    if (selfClose && !inSvg) flag("self-closing", lt);
    if (LOADERS.has(name.toLowerCase())) externalRefs.push(`<${name.toLowerCase()}>`);

    if (preDepth === 0) elements++;
    if (name === "head") { inHead = true; headIndex = 0; }
    else if (name === "body") inHead = false;
    else if (inHead) headIndex++;

    for (const [key, value] of attrs) {
      if (key === "style") styleAttrs++;
      if (key.startsWith("on")) inlineHandlers++;
      if (URL_ATTRS.has(key)) {
        const local = key !== "srcset" && (FRAGMENT.test(value) || (DATA_CONTEXTS.has(`${name} ${key}`) && DATA_IMAGE.test(value)));
        if (!local) externalRefs.push(`${key}=${value}`);
      }
      if (PAINT_ATTRS.has(key) && /url\(/i.test(value)) css(value, j);
    }

    if (name === "meta") {
      const httpEquiv = attrs.get("http-equiv");
      if (httpEquiv !== undefined && httpEquiv.trim().toLowerCase() === "refresh") externalRefs.push("<meta refresh>");
      const keys = [...attrs.keys()].sort().join(" ");
      const allowed = (keys === "charset" && attrs.get("charset") === "utf-8")
        || (keys === "content name" && META_NAMES.has(attrs.get("name")!))
        || (keys === "content http-equiv" && httpEquiv === "Content-Security-Policy");
      if (!allowed) flag("meta", lt);
      if (httpEquiv !== undefined && httpEquiv.trim().toLowerCase() === "content-security-policy") {
        cspCount++;
        if (csp === null) { csp = attrs.get("content") ?? ""; cspAt = inHead ? headIndex : -1; }
      }
    }

    if (!ok) {
      // Outside the subset: the rest of this tag is not read, and the page is already not clean.
      const gt = html.indexOf(">", j);
      i = gt < 0 ? html.length : gt + 1;
      continue;
    }
    i = j;
    if (selfClose) continue;
    if (name === "svg") svgDepth++;
    if (name === "pre") preDepth++;

    const raw = (name === "script" || name === "style") && !inSvg;
    if ((name === "script" || name === "style") && inSvg) flag("raw-text-in-svg", lt);
    if (raw || (name === "title" && !inSvg)) {
      const rel = html.slice(i).search(new RegExp(`</${name}`, "i"));
      if (rel < 0) {
        flag("unterminated", lt);
        i = html.length;
        continue;
      }
      const close = i + rel;
      const text = html.slice(i, close);
      const closer = `</${name}>`;
      if (!html.startsWith(closer, close)) flag("raw-text-closer", close);
      if (name === "title") {
        if (text.includes("<")) flag("title-text", i);
      } else {
        if (text.includes("<!--")) flag("raw-text-comment", i + text.indexOf("<!--"));
        if (name === "style") {
          styles.push(text);
          css(text, i);
        } else if (attrs.get("type") !== "application/json") {
          scripts.push(text);
        }
      }
      i = close + (html.startsWith(closer, close) ? closer.length : 2);
    }
  }
  if (dropped > 0) nonCanonical.push(`more ${dropped}`);

  const cspOk = nonCanonical.length === 0 && csp !== null && cspCount === 1 && cspAt === 2 && styles.length === 1 && scripts.length === 1
    && csp === cspFor(styles[0]!, scripts[0]!);
  return {
    bytes: new TextEncoder().encode(html).length,
    elements,
    csp,
    cspOk,
    externalRefs,
    styleAttrs,
    inlineHandlers,
    uncovered: uncoveredChars(html),
    nonCanonical,
  };
}
