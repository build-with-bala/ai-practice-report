/**
 * Canonical JSON (RFC 8785, JCS): the bytes another program signs, so they must be the same on every platform.
 * - Object keys sorted by their UTF-16 code units (JavaScript's default string order), no whitespace.
 * - Numbers in ECMAScript form (`Number#toString`, as `JSON.stringify` writes them; -0 is `0`); a non-finite number throws.
 * - Strings as `JSON.stringify` escapes them (`\b \t \n \f \r \" \\`, other controls as lower-case `\u00xx`, the rest raw).
 *   A string or key holding a lone surrogate throws, as RFC 8785 and I-JSON demand (P4 pre-flight G6).
 * - Only JSON data: null, booleans, finite numbers, strings, arrays and plain objects. Anything else throws (undefined
 *   included, in an object too), so nothing is silently left out of the signed bytes.
 * Pure and synchronous.
 */
export function canonicalJson(v: unknown): string {
  const out: string[] = [];
  write(v, out);
  return out.join("");
}

/** A high surrogate not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function str(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new TypeError("canonicalJson: a string holds a lone surrogate");
  return JSON.stringify(s);
}

function write(v: unknown, out: string[]): void {
  if (v === null) out.push("null");
  else if (typeof v === "boolean") out.push(v ? "true" : "false");
  else if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError("canonicalJson: a number is not finite");
    out.push(JSON.stringify(v));
  } else if (typeof v === "string") out.push(str(v));
  else if (Array.isArray(v)) {
    out.push("[");
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out.push(",");
      write(v[i], out);
    }
    out.push("]");
  } else if (typeof v === "object" && isPlain(v)) {
    const keys = Object.keys(v).sort();
    out.push("{");
    keys.forEach((k, i) => {
      if (i > 0) out.push(",");
      out.push(str(k), ":");
      write((v as Record<string, unknown>)[k], out);
    });
    out.push("}");
  } else throw new TypeError(`canonicalJson: not JSON data (${typeof v})`);
}

function isPlain(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
