import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type Platform = "darwin" | "linux" | "win32";

export interface Env {
  platform: Platform;
  home: string;
  tmp: string;
  appData?: string; // win32 only
  localAppData?: string; // win32 only
  xdgConfig: string; // $XDG_CONFIG_HOME or ~/.config
  xdgData: string; // $XDG_DATA_HOME or ~/.local/share
  xdgState: string; // $XDG_STATE_HOME or ~/.local/state
  vars: Record<string, string | undefined>; // CLAUDE_CONFIG_DIR, CODEX_HOME, ...
  wslHomes: string[]; // win32 only
}

const WSL_ROOT = "\\\\wsl.localhost\\";
const VAR_NAMES = ["CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** WSL user homes visible from Windows as `\\wsl.localhost\<distro>\home\<user>`. Empty off win32. */
export function listWslHomes(platform: Platform, lister: (dir: string) => string[] = safeList): string[] {
  if (platform !== "win32") return [];
  const homes: string[] = [];
  for (const distro of lister(WSL_ROOT)) {
    const homeDir = `${WSL_ROOT}${distro}\\home`;
    for (const user of lister(homeDir)) homes.push(`${homeDir}\\${user}`);
  }
  return homes;
}

function nonEmpty(v: string | undefined): string | undefined {
  return v ? v : undefined;
}

export function detectEnv(overrides: Partial<Env> = {}): Env {
  const platform: Platform = overrides.platform ?? (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux");
  const p = platform === "win32" ? path.win32 : path.posix;
  const e = process.env;
  const home = overrides.home ?? os.homedir();
  const vars: Record<string, string | undefined> = {};
  for (const k of VAR_NAMES) vars[k] = nonEmpty(e[k]);
  return {
    platform,
    home,
    tmp: overrides.tmp ?? os.tmpdir(),
    appData: overrides.appData ?? (platform === "win32" ? nonEmpty(e.APPDATA) : undefined),
    localAppData: overrides.localAppData ?? (platform === "win32" ? nonEmpty(e.LOCALAPPDATA) : undefined),
    xdgConfig: overrides.xdgConfig ?? nonEmpty(e.XDG_CONFIG_HOME) ?? p.join(home, ".config"),
    xdgData: overrides.xdgData ?? nonEmpty(e.XDG_DATA_HOME) ?? p.join(home, ".local", "share"),
    xdgState: overrides.xdgState ?? nonEmpty(e.XDG_STATE_HOME) ?? p.join(home, ".local", "state"),
    vars: overrides.vars ?? vars,
    wslHomes: overrides.wslHomes ?? listWslHomes(platform),
  };
}
