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
 *    `<svg>`); `/>` only inside `<svg>`. End tags are exactly `</name>`.
 *    - **Strict nesting:** an open-element stack; every non-void element is closed by its own end tag in LIFO order, void
 *      elements (`meta`, `br`, `hr`) have none; a mismatch, a stray end tag or an element left open is a finding.
 *    - **Structure:** after the doctype, exactly one `<html>` holding exactly one `<head>` and then one `<body>`, with
 *      only white space between them and after `</html>`. `<meta>`, `<title>` and `<style>` only as direct children of
 *      that head, and nothing else there. The CSP position check is tied to that head.
 *    - **Charset:** that head's first element child is exactly `<meta charset="utf-8">`, ending within the first 1,024
 *      bytes, where browsers look for it; without it they fall back to a legacy encoding or guess one. The CSP meta is
 *      the second child.
 *    - **No implied tree changes:** `<p>` holds only phrasing elements, headings do not nest, `<a>` and `<button>` do not
 *      nest in themselves, `li`/`dt`/`dd` and table parts have only their proper parents, tables and rows hold only
 *      their parts and white space. So the tree builder never closes, inserts or moves an element.
 * 3. Attributes are only ` name="value"`: separated by ASCII spaces or newlines, the name matching
 *    `[A-Za-z][A-Za-z0-9:-]*`, the value double-quoted with no raw `<`, `>` or `"`, and no name twice in a tag. An `id`
 *    is an ASCII letter followed by ASCII letters, digits, `_` and `-` (`id-form`: so no character reference, space or
 *    empty id), and no two elements on the page, HTML or SVG, share one (`duplicate-id`).
 *    `style` and `on…` attributes are counted in `styleAttrs` and `inlineHandlers`.
 * 4. URL attributes (`URL_ATTRS`) hold exactly a `#fragment` whose id has the id form of rule 3, or a `data:image/…` URL on an image (`DATA_CONTEXTS`),
 *    matched literally: no trimming and no entity decoding. `srcset` is never allowed. A violation is an external ref.
 * 5. `<meta>` is only `charset="utf-8"`, `name` viewport, color-scheme or referrer with `content`, or
 *    `http-equiv="Content-Security-Policy"` with `content`.
 * 6. Raw text only in `<style>` and `<script>` outside `<svg>`: their text holds no `<!--` and no closer but the real,
 *    exact `</style>` or `</script>`. No `<style>`, `<script>` or `<foreignObject>` inside `<svg>`. `<title>` text holds
 *    no `<`; inside `<svg>`, `<title>` and `<desc>` (HTML integration points) hold text only, up to their own end tag. CSS holds no backslash escape but those `cssString` writes, and its `url(…)` is exactly `#id` or a font or
 *    image `data:` URL.
 *    SVG paint attributes (`PAINT_ATTRS`) hold no `&` and no `\`, so no entity or CSS escape can spell a `url(` that
 *    the literal check would miss.
 * 7. A `<` in text that does not start an allowed tag, a NUL anywhere, any other C0 control but tab, LF and CR anywhere
 *    (text, title, attribute values, style and script text), or anything else inside a tag is a finding.
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
   * The page is canonical (`nonCanonical` is empty), so the head's first element is `<meta charset="utf-8">`; the CSP
   * meta is the second element of `<head>`, there is one
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
/** SVG presentation attributes that take a CSS `url(…)`: checked like CSS, and holding no `&` or `\`. */
const PAINT_ATTRS: ReadonlySet<string> = new Set(["fill", "stroke", "clip-path", "mask", "filter", "marker", "marker-start", "marker-mid", "marker-end",
  "cursor"]);
/** Elements that load or redirect something whatever their attributes say. */
const LOADERS: ReadonlySet<string> = new Set(["link", "iframe", "object", "embed", "base"]);
const META_NAMES: ReadonlySet<string> = new Set(["viewport", "color-scheme", "referrer"]);

/** The one form of an id: an ASCII letter, then ASCII letters, digits, `_` and `-`. No character reference can occur in it. */
const ID_FORM = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** A fragment reference: `#` and an id in that same form. */
const FRAGMENT = /^#[A-Za-z][A-Za-z0-9_-]*$/;
const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+(?:;base64)?,[A-Za-z0-9+/=%]*$/;
/** A canonical CSS `url(`: an id, or a woff2 font or image as base64 or percent-encoded data. */
const CSS_URL = /url\((?:#[A-Za-z][\w-]*|data:(?:font\/woff2|image\/[a-z0-9.+-]+)(?:;base64)?,[A-Za-z0-9+/=%]*)\)/y;
/** The escapes `cssString` writes: `\\`, `\"`, `\A `, `\3C ` and `\3E `. */
const CSS_ESCAPE = /\\(?:\\|"|A |3C |3E )/y;
/** One canonical attribute, read from `lastIndex`. */
const ATTR = /[ \n]+([A-Za-z][A-Za-z0-9:-]*)="([^<>"]*)"/y;
const TAG_NAME = /[A-Za-z][A-Za-z0-9]*/y;
const END_TAG = /<\/([A-Za-z][A-Za-z0-9]*)>/y;
/** C0 controls other than tab, LF and CR (NUL has its own code). */
const CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/g;
const CHARSET_META = '<meta charset="utf-8">';
/** Browsers look for the charset meta in the first 1,024 bytes. */
const CHARSET_BYTES = 1024;
const MAX_FINDINGS = 50;

const stickyAt = (re: RegExp, s: string, at: number): RegExpMatchArray | null => {
  re.lastIndex = at;
  return s.match(re);
};

/** HTML elements with no end tag. */
const VOID: ReadonlySet<string> = new Set(["meta", "br", "hr"]);
/** The elements a `<p>` may hold: any other start tag inside a `<p>` would close it implicitly. */
const PHRASING: ReadonlySet<string> = new Set(["span", "a", "strong", "em", "b", "i", "small", "code", "abbr", "time", "br", "sup", "sub", "kbd",
  "svg", "button"]);
const HEADINGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4"]);
/** Elements valid only as direct children of the one `<head>`. */
const HEAD_ONLY: ReadonlySet<string> = new Set(["meta", "title", "style"]);
/** The only parents each element may have, where the tree builder would otherwise insert, close or move elements. */
const PARENTS: Readonly<Record<string, readonly string[]>> = {
  li: ["ol", "ul"], dt: ["dl"], dd: ["dl"],
  caption: ["table"], thead: ["table"], tbody: ["table"], tfoot: ["table"], tr: ["thead", "tbody", "tfoot"], th: ["tr"], td: ["tr"],
};
/** Elements whose children are fixed: only these, and only white space as text (no foster parenting, no implied tbody). */
const CHILDREN: Readonly<Record<string, readonly string[]>> = {
  table: ["caption", "thead", "tbody", "tfoot"], thead: ["tr"], tbody: ["tr"], tfoot: ["tr"], tr: ["th", "td"],
};
const SPACE_ONLY = /^[ \t\n\r\f]*$/;

interface Open { name: string; svg: boolean }

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
  let headIndex = 0;
  let charsetOk = false;
  let preDepth = 0;
  /** Every id seen so far, HTML and SVG alike: a fragment or a label pointing at a repeated id is ambiguous. */
  const ids = new Set<string>();
  /** The open elements, innermost last. */
  const stack: Open[] = [];
  /** 0 before <html>, 1 in html before head, 2 in head, 3 between head and body, 4 in body, 5 after body, 6 after </html>. */
  let phase = 0;

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

  const top = (): Open | undefined => stack[stack.length - 1];
  const has = (name: string): boolean => stack.some((o) => o.name === name);
  /** Text between tags: only white space where the tree builder would move or reparent it. */
  const text = (from: number, to: number): void => {
    if (from >= to) return;
    const t = top();
    const strict = t === undefined || t.name === "html" || t.name === "head" || Object.hasOwn(CHILDREN, t.name);
    if (strict && !SPACE_ONLY.test(html.slice(from, to))) flag("structure", from);
  };

  const nul = html.indexOf("\u0000");
  if (nul >= 0) flag("nul", nul);
  for (const m of html.matchAll(CONTROL)) flag("control", m.index!);
  let i = 0;
  if (html.startsWith("<!doctype html>")) i = "<!doctype html>".length;
  else flag("doctype", 0);

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    text(i, lt < 0 ? html.length : lt);
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
      const t = top();
      if (name === undefined || t === undefined || t.name !== name) {
        flag("end-tag", lt);
        i = lt + 2;
        continue;
      }
      stack.pop();
      if (name === "pre") preDepth--;
      else if (name === "head") {
        phase = 3;
        if (headIndex === 0) flag("charset", lt);
      }
      else if (name === "body") phase = 5;
      else if (name === "html") phase = 6;
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
    const parent = top();
    const inSvg = parent?.svg ?? false;
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

    // element, context and structure
    if (name === "foreignObject") flag("foreign-object", lt);
    else if (!(inSvg ? SVG_SET : HTML_SET).has(name)) flag("element", lt);
    if (selfClose && !inSvg) flag("self-closing", lt);
    if (LOADERS.has(name.toLowerCase())) externalRefs.push(`<${name.toLowerCase()}>`);
    if (name === "html") {
      if (phase !== 0 || parent !== undefined) flag("structure", lt);
      phase = 1;
    } else if (name === "head") {
      if (phase !== 1 || parent?.name !== "html") flag("structure", lt);
      phase = 2;
      headIndex = 0;
    } else if (name === "body") {
      if (phase !== 3 || parent?.name !== "html") flag("structure", lt);
      phase = 4;
    } else if (!inSvg) {
      const inHead = phase === 2 && parent?.name === "head";
      if (inHead) headIndex++;
      if (inHead && headIndex === 1) {
        const end = lt + CHARSET_META.length;
        charsetOk = html.startsWith(CHARSET_META, lt) && new TextEncoder().encode(html.slice(0, end)).length <= CHARSET_BYTES;
        if (!charsetOk) flag("charset", lt);
      }
      if (HEAD_ONLY.has(name) !== inHead) flag("structure", lt);
      if (!inHead && phase !== 4) flag("structure", lt);
      if (!PHRASING.has(name) && has("p")) flag("content", lt);
      if (HEADINGS.has(name) && stack.some((o) => HEADINGS.has(o.name))) flag("content", lt);
      if ((name === "a" || name === "button") && has(name)) flag("content", lt);
      const parents = PARENTS[name];
      if (parents !== undefined && !parents.includes(parent?.name ?? "")) flag("content", lt);
    }
    const children = parent === undefined ? undefined : CHILDREN[parent.name];
    if (children !== undefined && !children.includes(name)) flag("content", lt);

    if (preDepth === 0) elements++;

    const id = attrs.get("id");
    if (id !== undefined) {
      // Only the one form is compared, so two ids a browser reads as equal are equal here too: no decoding needed.
      if (!ID_FORM.test(id)) flag("id-form", lt);
      else if (ids.has(id)) flag("duplicate-id", lt);
      ids.add(id);
    }
    for (const [key, value] of attrs) {
      if (key === "style") styleAttrs++;
      if (key.startsWith("on")) inlineHandlers++;
      if (URL_ATTRS.has(key)) {
        const local = key !== "srcset" && (FRAGMENT.test(value) || (DATA_CONTEXTS.has(`${name} ${key}`) && DATA_IMAGE.test(value)));
        if (!local) externalRefs.push(`${key}=${value}`);
      }
      if (PAINT_ATTRS.has(key)) {
        if (/[&\\]/.test(value)) flag("paint-escape", j);
        if (/url\(/i.test(value)) css(value, j);
      }
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
        // Only a CSP meta that is a child of the one head counts; any other is already a structure finding.
        if (csp === null && phase === 2 && parent?.name === "head") { csp = attrs.get("content") ?? ""; cspAt = headIndex; }
      }
    }

    if (!ok) {
      // Outside the subset: the rest of this tag is not read, and the page is already not clean.
      const gt = html.indexOf(">", j);
      i = gt < 0 ? html.length : gt + 1;
      continue;
    }
    i = j;
    if (selfClose || (!inSvg && VOID.has(name))) continue;

    if ((name === "script" || name === "style") && inSvg) flag("raw-text-in-svg", lt);
    if (inSvg && (name === "title" || name === "desc")) {
      // An HTML integration point: it may hold text only, up to its own exact end tag.
      const close = html.indexOf("<", i);
      const closer = `</${name}>`;
      if (close < 0 || !html.startsWith(closer, close)) {
        flag("svg-text", lt);
        stack.push({ name, svg: true });
        continue;
      }
      i = close + closer.length;
      continue;
    }
    const raw = (name === "script" || name === "style") && !inSvg;
    if (raw || (name === "title" && !inSvg)) {
      const rel = html.slice(i).search(new RegExp(`</${name}`, "i"));
      if (rel < 0) {
        flag("unterminated", lt);
        i = html.length;
        continue;
      }
      const close = i + rel;
      const body = html.slice(i, close);
      const closer = `</${name}>`;
      if (!html.startsWith(closer, close)) flag("raw-text-closer", close);
      if (name === "title") {
        if (body.includes("<")) flag("title-text", i);
      } else {
        if (body.includes("<!--")) flag("raw-text-comment", i + body.indexOf("<!--"));
        if (name === "style") {
          styles.push(body);
          css(body, i);
        } else if (attrs.get("type") !== "application/json") {
          scripts.push(body);
        }
      }
      i = close + (html.startsWith(closer, close) ? closer.length : 2);
      continue;
    }
    stack.push({ name, svg: inSvg || name === "svg" });
    if (name === "pre") preDepth++;
  }
  if (stack.length > 0) flag("unclosed", html.length);
  if (phase !== 6) flag("structure", html.length);
  if (dropped > 0) nonCanonical.push(`more ${dropped}`);

  const cspOk = nonCanonical.length === 0 && charsetOk && csp !== null && cspCount === 1 && cspAt === 2 && styles.length === 1 && scripts.length === 1
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
