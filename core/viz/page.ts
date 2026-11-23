import { createHash } from "node:crypto";
import { kitCss } from "./css";
import { fontFaceCss } from "./fonts";
import { esc } from "./html";
import { KIT_RUNTIME } from "./runtime";

export interface PageOptions {
  title: string;
  /** The running print footer's left text, e.g. "Name · No. 7F3A-91C2". */
  footerLeft: string;
  /** The body's HTML, or a function of the page's CSP that returns it. */
  body: string | ((c: { csp: string }) => string);
  /** Extra CSS, after the kit stylesheet. */
  css?: string;
  /** Extra script, after the kit runtime. */
  script?: string;
  /** `embed` (default) embeds the fonts as `data:` URIs; `none` leaves them out (snapshots). */
  fonts?: "embed" | "none";
  /** The `data-theme` on `<html>`: `auto` (default) follows `prefers-color-scheme`. */
  theme?: "auto" | "ink" | "paper";
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("base64");

/** The page's Content-Security-Policy: the one inline style and the one inline script pinned by SHA-256, `data:` images and fonts, nothing else. */
export function cspFor(style: string, script: string): string {
  return `default-src 'none'; script-src 'sha256-${sha256(script)}'; style-src 'sha256-${sha256(style)}'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'`;
}

/** The HTML parser turns CR and CRLF into LF before the browser hashes an element's text, so the hash is taken over LF text. */
const lf = (s: string): string => s.replace(/\r\n?/g, "\n");

/** The hatch pattern the `m-hatch` mark fills with: 45°, a 4-unit pitch and a 1-unit `ref` stroke. */
const KIT_DEFS = '<svg class="kit-defs" aria-hidden="true" focusable="false"><defs><pattern id="kit-hatch" width="4" height="4"'
  + ' patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line class="kit-hatch-line" x1="0" y1="0" x2="0" y2="4"/></pattern></defs></svg>';

/**
 * One self-contained report page: inline CSS, script and fonts, a CSP that pins them by hash, the hatch defs, the body,
 * the print footer fallback and the runtime. Deterministic: the same options give the same bytes.
 */
export function page(o: PageOptions): string {
  const style = lf([...(o.fonts === "none" ? [] : [fontFaceCss()]), kitCss({ footerLeft: o.footerLeft }), ...(o.css ? [o.css] : [])].join("\n"));
  const script = lf([KIT_RUNTIME, ...(o.script ? [o.script] : [])].join("\n"));
  if (/<\/style/i.test(style)) throw new Error("page: the CSS holds </style");
  if (/<\/script|<!--/i.test(script)) throw new Error("page: the script holds </script or <!--");
  const csp = cspFor(style, script);
  const body = typeof o.body === "function" ? o.body({ csp }) : o.body;
  return '<!doctype html><html lang="en" data-theme="' + (o.theme ?? "auto") + '"><head>'
    + '<meta charset="utf-8">'
    // The policy holds only keywords, single quotes and base64, so it needs no escaping in a double-quoted attribute.
    + `<meta http-equiv="Content-Security-Policy" content="${csp}">`
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="color-scheme" content="dark light">'
    + '<meta name="referrer" content="no-referrer">'
    + `<title>${esc(o.title)}</title>`
    + `<style>${style}</style></head><body>`
    + KIT_DEFS
    + body
    + `<div class="print-footer" aria-hidden="true"><span>${esc(o.footerLeft)}</span></div>`
    + `<script>${script}</script></body></html>`;
}
