import path from "node:path";
import type { Env } from "./env";

/** Join with Windows semantics on win32, POSIX otherwise (independent of the host OS). */
export function joinFor(env: Env, ...parts: string[]): string {
  return env.platform === "win32" ? path.win32.join(...parts) : path.posix.join(...parts);
}

export function appSupport(env: Env, app: string): string {
  if (env.platform === "darwin") return joinFor(env, env.home, "Library", "Application Support", app);
  if (env.platform === "win32") return joinFor(env, env.appData ?? joinFor(env, env.home, "AppData", "Roaming"), app);
  return joinFor(env, env.xdgConfig, app);
}

export function vscodeUser(env: Env, app: string): string {
  return joinFor(env, appSupport(env, app), "User");
}

export function homesToScan(env: Env, wsl: boolean): string[] {
  return [env.home, ...(wsl ? env.wslHomes : [])];
}

/** Replace a leading home directory with "~" (only on a path-segment boundary). */
export function tildify(env: Env, p: string): string {
  const win = env.platform === "win32";
  const home = env.home.replace(win ? /[\\/]+$/ : /\/+$/, "");
  if (!home) return p;
  const eq = (a: string, b: string) => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (eq(p, home)) return "~";
  const head = p.slice(0, home.length);
  const next = p.charAt(home.length);
  const sepOk = win ? next === "\\" || next === "/" : next === "/";
  return eq(head, home) && sepOk ? "~" + p.slice(home.length) : p;
}
