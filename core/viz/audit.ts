import { uncoveredChars } from "./fonts";
import { cspFor } from "./page";

/** What `auditHtml` finds in a page: its size, its element count, its CSP, and whatever breaks the report rules. */
export interface Audit {
  /** UTF-8 bytes. */
  bytes: number;
  /** Start tags outside `<script>`, `<style>` and `<pre>`. */
  elements: number;
  /** The CSP meta's policy, or null. */
  csp: string | null;
  /** The CSP meta is the second element of `<head>`, there is one `<style>` and one executable `<script>`, and the CSP pins them. */
  cspOk: boolean;
  /**
   * Every URL attribute (`src`, `href`, `action`, `formaction`, `poster`, `srcset`, `xlink:href`, `data`, `ping`,
   * `background`), CSS `url(…)` and `@import` whose target is not `#…` or `data:…`, as `name=value`, `url(target)` or
   * `@import target`; every `<link>`, `<iframe>`, `<object>`, `<embed>` and `<base>`, as `<name>`; and every
   * `<meta http-equiv="refresh">`, as `<meta refresh>`, since CSP does not block that navigation.
   */
  externalRefs: string[];
  styleAttrs: number;
  inlineHandlers: number;
  /** Characters no embedded font covers. */
  uncovered: string[];
}

interface StartTag { name: string; attrs: [string, string | null][] }

/** The attributes whose value is a URL. */
const URL_ATTRS: ReadonlySet<string> = new Set(["src", "href", "action", "formaction", "poster", "srcset", "xlink:href", "data", "ping", "background"]);
/** Elements that load or redirect something whatever their attributes say. */
const LOADERS: ReadonlySet<string> = new Set(["link", "iframe", "object", "embed", "base"]);
/** Elements whose content is raw text, not markup. */
const RAW_TEXT: ReadonlySet<string> = new Set(["script", "style"]);

const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", sol: "/", num: "#", period: ".", tab: "\t", newline: "\n" };

/** An attribute value with its character references decoded, so an encoded URL is seen as the URL it is. */
function decode(s: string): string {
  return s.replace(/&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|([A-Za-z]+));?/g, (m, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (hex !== undefined || dec !== undefined) {
      const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec!, 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[name!.toLowerCase()] ?? m;
  });
}

const isLocal = (target: string): boolean => {
  const t = target.trim();
  return t.startsWith("#") || /^data:/i.test(t);
};

/**
 * A srcset's candidate URLs, as the HTML spec parses them: skip white space and commas, read the URL up to white space
 * (trailing commas end the candidate), then skip the descriptors up to a comma outside parentheses.
 */
function srcsetTargets(v: string): string[] {
  const out: string[] = [];
  const space = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";
  let i = 0;
  while (i < v.length) {
    while (i < v.length && (space(v[i]!) || v[i] === ",")) i++;
    if (i >= v.length) break;
    let j = i;
    while (j < v.length && !space(v[j]!)) j++;
    let url = v.slice(i, j);
    i = j;
    if (url.endsWith(",")) url = url.replace(/,+$/, "");
    else {
      let depth = 0;
      for (; i < v.length; i++) {
        const c = v[i];
        if (c === "(") depth++;
        else if (c === ")") depth = Math.max(0, depth - 1);
        else if (c === "," && depth === 0) { i++; break; }
      }
    }
    if (url !== "") out.push(url);
  }
  return out;
}

/** Every CSS `url(…)` and `@import` target in a text. */
function cssRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi)) {
    const target = m[1] ?? m[2] ?? m[3] ?? "";
    if (!isLocal(target)) out.push(`url(${target})`);
  }
  for (const m of text.matchAll(/@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s;)]+))/gi)) {
    const target = m[1] ?? m[2] ?? m[3] ?? "";
    if (!isLocal(target)) out.push(`@import ${target}`);
  }
  return out;
}

/**
 * One attribute, read from `lastIndex` (sticky): a name, then a double-quoted, single-quoted or bare value, if any. As
 * in the HTML spec, a name may start with any character but white space, `/` and `>` (a quote or `=` included).
 */
const ATTR = /[\s/]*([^\s/>][^\s/>=]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/y;

/** The start tag at `at` (which holds `<` and a letter): its name, attributes and the index after its `>`. */
function startTag(html: string, at: number): { tag: StartTag; end: number } {
  const name = html.slice(at + 1).match(/^[A-Za-z][^\s/>]*/)![0].toLowerCase();
  let i = at + 1 + name.length;
  const attrs: [string, string | null][] = [];
  for (;;) {
    ATTR.lastIndex = i;
    const m = html.match(ATTR);
    if (m === null || m[0] === "") break;
    const raw = m[2] ?? m[3] ?? m[4];
    attrs.push([m[1]!.toLowerCase(), raw === undefined ? null : decode(raw)]);
    i = ATTR.lastIndex;
  }
  const close = html.indexOf(">", i);
  return { tag: { name, attrs }, end: close < 0 ? html.length : close + 1 };
}

const attrOf = (t: StartTag, name: string): string | null | undefined => t.attrs.find(([n]) => n === name)?.[1];

/** Audits one report page against the report rules: CSP, external references, style attributes, handlers, glyphs. */
export function auditHtml(html: string): Audit {
  let elements = 0;
  let preDepth = 0;
  let inHead = false;
  let headIndex = 0;
  let cspAt = -1;
  let cspCount = 0;
  let csp: string | null = null;
  const styles: string[] = [];
  const scripts: string[] = [];
  const externalRefs: string[] = [];
  let styleAttrs = 0;
  let inlineHandlers = 0;

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      // As browsers do: `<!-->` and `<!--->` close at once, and `--!>` closes like `-->`.
      if (html.startsWith("<!-->", lt)) { i = lt + 5; continue; }
      if (html.startsWith("<!--->", lt)) { i = lt + 6; continue; }
      const m = html.slice(lt + 4).match(/--!?>/);
      i = m === null ? html.length : lt + 4 + m.index! + m[0].length;
      continue;
    }
    const next = html[lt + 1] ?? "";
    if (next === "!" || next === "?") {
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (next === "/") {
      const m = html.slice(lt, lt + 64).match(/^<\/([A-Za-z][^\s/>]*)/);
      const name = m?.[1]?.toLowerCase();
      if (name === "pre" && preDepth > 0) preDepth--;
      if (name === "head") inHead = false;
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(next)) {
      i = lt + 1;
      continue;
    }

    const { tag, end } = startTag(html, lt);
    i = end;
    if (preDepth === 0) elements++;
    if (tag.name === "pre") preDepth++;
    if (tag.name === "head") { inHead = true; headIndex = 0; }
    else if (tag.name === "body") inHead = false;
    else if (inHead) headIndex++;

    if (tag.name === "meta" && (attrOf(tag, "http-equiv") ?? "").trim().toLowerCase() === "content-security-policy") {
      cspCount++;
      if (csp === null) { csp = attrOf(tag, "content") ?? ""; cspAt = inHead ? headIndex : -1; }
    }
    if (LOADERS.has(tag.name)) externalRefs.push(`<${tag.name}>`);
    if (tag.name === "meta" && (attrOf(tag, "http-equiv") ?? "").trim().toLowerCase() === "refresh") externalRefs.push("<meta refresh>");
    for (const [name, value] of tag.attrs) {
      if (name === "style") styleAttrs++;
      if (name.startsWith("on") && value !== null) inlineHandlers++;
      if (value === null) continue;
      if (name === "srcset") {
        if (srcsetTargets(value).some((t) => !isLocal(t))) externalRefs.push(`srcset=${value}`);
      } else if (name === "ping") {
        if (value.split(/[\t\n\f\r ]+/).some((t) => t !== "" && !isLocal(t))) externalRefs.push(`ping=${value}`);
      } else if (URL_ATTRS.has(name) && !isLocal(value)) {
        externalRefs.push(`${name}=${value.trim()}`);
      }
      externalRefs.push(...cssRefs(value));
    }

    if (RAW_TEXT.has(tag.name)) {
      const close = html.slice(i).search(new RegExp(`</${tag.name}[\\s/>]`, "i"));
      const textEnd = close < 0 ? html.length : i + close;
      const text = html.slice(i, textEnd);
      if (tag.name === "style") {
        styles.push(text);
        externalRefs.push(...cssRefs(text));
      } else if ((attrOf(tag, "type") ?? "").trim().toLowerCase() !== "application/json") {
        scripts.push(text);
      }
      const after = html.indexOf(">", textEnd);
      i = close < 0 || after < 0 ? html.length : after + 1;
    }
  }

  const cspOk = csp !== null && cspCount === 1 && cspAt === 2 && styles.length === 1 && scripts.length === 1
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
  };
}
