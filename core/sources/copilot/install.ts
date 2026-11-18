import { readdirSync } from "node:fs";
import type { Env } from "../../env/env";
import { joinFor } from "../../env/paths";

/** The VS Code builds whose chat sessions the reader looks for (`vscodeUser(env, app)`). */
export const VS_APPS = ["Code", "Code - Insiders", "VSCodium"] as const;
export type VsApp = (typeof VS_APPS)[number];

/** Where a VS Code build keeps its bundled extensions, and where the user's own extensions go. */
export interface InstallDirs { bundles: string[]; extensions: string[] }

/** Per build: the macOS app name, the Windows user-install folder, the Linux package folder and the user extension folder. */
const BUILDS: Record<VsApp, { mac?: string; win?: string; linux?: string; ext: string }> = {
  "Code": { mac: "Visual Studio Code.app", win: "Microsoft VS Code", linux: "/usr/share/code", ext: ".vscode" },
  "Code - Insiders": { mac: "Visual Studio Code - Insiders.app", win: "Microsoft VS Code Insiders", linux: "/usr/share/code-insiders", ext: ".vscode-insiders" },
  "VSCodium": { ext: ".vscode-oss" }, // ships without Copilot; it can only be installed as a user extension
};

/**
 * Folders that hold a bundled Copilot (`extensions/copilot*`, VS Code 1.1xx ships it inside the app) and the user's
 * extension folder (`github.copilot*` when installed from the marketplace): macOS `/Applications/<app>` and
 * `~/Applications/<app>`; Windows `%LOCALAPPDATA%\Programs\<folder>` (the user install); Linux `/usr/share/<package>`.
 */
export function installDirs(env: Env, app: VsApp): InstallDirs {
  const b = BUILDS[app];
  const bundles: string[] = [];
  if (env.platform === "darwin" && b.mac) {
    for (const apps of ["/Applications", joinFor(env, env.home, "Applications")]) bundles.push(joinFor(env, apps, b.mac, "Contents", "Resources", "app", "extensions"));
  } else if (env.platform === "win32" && b.win && env.localAppData) {
    bundles.push(joinFor(env, env.localAppData, "Programs", b.win, "resources", "app", "extensions"));
  } else if (env.platform === "linux" && b.linux) {
    bundles.push(joinFor(env, b.linux, "resources", "app", "extensions"));
  }
  return { bundles, extensions: [joinFor(env, env.home, b.ext, "extensions")] };
}

function hasEntry(dir: string, prefix: string): boolean {
  try {
    return readdirSync(dir).some((name) => name.toLowerCase().startsWith(prefix));
  } catch {
    return false;
  }
}

/** Copilot is installed: a bundled `copilot*` extension, or a `github.copilot*` user extension (only names are listed). */
export function copilotInstalled(dirs: InstallDirs): boolean {
  return dirs.bundles.some((d) => hasEntry(d, "copilot")) || dirs.extensions.some((d) => hasEntry(d, "github.copilot"));
}
