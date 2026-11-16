import { expect, test } from "bun:test";
import { detectEnv, listWslHomes } from "../../../core/env/env";
import { appSupport, homesToScan, tildify, vscodeUser } from "../../../core/env/paths";

test("darwin app support and VS Code user dir", () => {
  const env = detectEnv({ platform: "darwin", home: "/Users/dev" });
  expect(appSupport(env, "Antigravity IDE")).toBe("/Users/dev/Library/Application Support/Antigravity IDE");
  expect(vscodeUser(env, "Cursor")).toBe("/Users/dev/Library/Application Support/Cursor/User");
});
test("win32 uses APPDATA and backslashes, spaces preserved", () => {
  const env = detectEnv({ platform: "win32", home: "C:\\Users\\Jo Ann", appData: "C:\\Users\\Jo Ann\\AppData\\Roaming" });
  expect(appSupport(env, "Cursor")).toBe("C:\\Users\\Jo Ann\\AppData\\Roaming\\Cursor");
  expect(tildify(env, "C:\\Users\\Jo Ann\\.codex\\x")).toBe("~\\.codex\\x");
});
test("linux honours XDG_CONFIG_HOME", () => {
  const env = detectEnv({ platform: "linux", home: "/home/dev", xdgConfig: "/x" });
  expect(appSupport(env, "Cursor")).toBe("/x/Cursor");
});
test("WSL homes are discovered through the injected lister", () => {
  const lister = (d: string) => (d === "\\\\wsl.localhost\\" ? ["Ubuntu"] : d.endsWith("\\home") ? ["dev"] : []);
  expect(listWslHomes("win32", lister)).toEqual(["\\\\wsl.localhost\\Ubuntu\\home\\dev"]);
  expect(listWslHomes("darwin", lister)).toEqual([]);
});
test("homesToScan includes WSL homes only when asked", () => {
  const env = detectEnv({ platform: "win32", home: "C:\\u", appData: "C:\\u\\a", wslHomes: ["\\\\wsl.localhost\\U\\home\\d"] });
  expect(homesToScan(env, false)).toEqual(["C:\\u"]);
  expect(homesToScan(env, true)).toHaveLength(2);
});
