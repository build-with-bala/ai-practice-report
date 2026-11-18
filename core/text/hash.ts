import { createHmac } from "node:crypto";

/** HMAC-SHA256 keyed hash, lowercase hex prefix of `len` chars. */
export function keyedHash(salt: Uint8Array, value: string, len = 16): string {
  return createHmac("sha256", salt).update(value).digest("hex").slice(0, len);
}

/** Pure string path normalization: "\" → "/", resolve "."/"..", drop trailing "/", lowercase a leading drive letter. */
export function normalizePath(p: string): string {
  if (!p) return "";
  let s = p.replace(/\\/g, "/");
  let prefix = "";
  const drive = /^([A-Za-z]):(?=\/|$)/.exec(s);
  if (drive) {
    prefix = drive[1]!.toLowerCase() + ":";
    s = s.slice(2);
  }
  const absolute = s.startsWith("/");
  const stack: string[] = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (stack.length && stack[stack.length - 1] !== "..") stack.pop();
      else if (!absolute) stack.push("..");
    } else stack.push(seg);
  }
  const body = stack.join("/");
  if (absolute) return prefix + "/" + body;
  return prefix + (body || (prefix ? "" : "."));
}
