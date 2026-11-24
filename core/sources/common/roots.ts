import type { Env } from "../../env/env";
import { joinFor } from "../../env/paths";
import { isDir } from "../../io/fs";
import type { Candidate } from "../types";

/**
 * A CLI's config root per home: `$<envVar>` for the scanning user's home when set, else `<home>/<dirName>`
 * (also per WSL home); only existing folders, each once.
 */
export function configRoots(env: Env, homes: string[], envVar: string, dirName: string): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const home of homes) {
    const primary = home === env.home;
    const root = primary && env.vars[envVar] ? env.vars[envVar]! : joinFor(env, home, dirName);
    if (seen.has(root) || !isDir(root)) continue;
    seen.add(root);
    out.push({ root, home, wsl: !primary });
  }
  return out;
}
