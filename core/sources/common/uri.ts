import type { Platform } from "../../env/env";

/** The path of a `file:` or `vscode-remote:` URI (a Windows drive or UNC path on win32); undefined for other URIs. */
export function uriToPath(uri: string, platform: Platform): string | undefined {
  let u: URL;
  let p: string;
  try {
    u = new URL(uri);
    p = decodeURIComponent(u.pathname);
  } catch {
    return undefined;
  }
  if ((u.protocol !== "file:" && u.protocol !== "vscode-remote:") || p === "") return undefined;
  if (u.protocol === "file:" && platform === "win32") {
    p = u.host ? `//${u.host}${p}` : p.replace(/^\/([A-Za-z]:)/, "$1");
    p = p.replace(/\//g, "\\");
  }
  return p;
}
