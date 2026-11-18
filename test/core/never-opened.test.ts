import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonSmall, readJsonSmallResult, readTextLines } from "../../core/io/fs";
import { readJsonl } from "../../core/io/jsonl";
import { __observeOpens, type OpenHow } from "../../core/io/observe";
import { openRo } from "../../core/io/sqlite";
import { TempRegistry } from "../../core/io/temp";
import { scan } from "../../core/scan";
import { registry } from "../../core/sources/registry";
import { buildAntigravity } from "../fixtures/antigravity";
import { buildCcLifetime, buildCcTranscripts } from "../fixtures/claude-code";
import { buildCodexIndex, buildCodexRollouts } from "../fixtures/codex";
import { buildCopilot, jetbrainsRel } from "../fixtures/copilot";
import { buildAgentCli, buildCursor } from "../fixtures/cursor";
import { CANARY } from "../kit/canary";
import { fakeHome, type FakeHome } from "../kit/home";

/** Credentials, OAuth tokens and keys, where the tools and the system keep them: no reader may ever open one. */
const PLANTED = [
  ".codex/auth.json", ".claude/.credentials.json", ".config/github-copilot/apps.json", ".config/github-copilot/hosts.json",
  ".ssh/id_ed25519", ".codex/x.key",
];
/** How the path of a never-opened file ends: no open may have it, by the path opened or by the file behind a link. */
const NEVER_OPENED = ["auth.json", ".credentials.json", "apps.json", "hosts.json", "id_ed25519", ".key"];

interface Open { path: string; how: OpenHow }

let h: FakeHome;
beforeEach(() => {
  h = fakeHome();
});
afterEach(() => {
  __observeOpens(undefined);
  h.cleanup();
});

/** The opens that `run` makes, in order, as the core/io primitives report them. */
async function recordOpens(run: () => unknown): Promise<Open[]> {
  const opens: Open[] = [];
  __observeOpens((p, how) => opens.push({ path: p, how }));
  try {
    await run();
  } finally {
    __observeOpens(undefined);
  }
  return opens;
}

/** A file's real path, links resolved (on macOS the temp folder itself lies behind a link); the path itself when it cannot be resolved. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The opens that break the rules, as `<how> <path>: <rule>`: a path — as opened, or the file behind a link — that ends
 * like a never-opened file, or that lies outside the home's root.
 */
function violations(opens: Open[], root: string): string[] {
  const roots = [root, real(root)].map((r) => r + path.sep);
  const found: string[] = [];
  for (const o of opens) {
    for (const p of new Set([o.path, real(o.path)])) {
      if (NEVER_OPENED.some((end) => p.endsWith(end))) found.push(`${o.how} ${p}: never opened`);
      if (!roots.some((r) => p.startsWith(r))) found.push(`${o.how} ${p}: outside the home`);
    }
  }
  return found;
}

/** A link at `at` to `target`; false where links cannot be made (Windows without the right to make them). */
function link(target: string, at: string): boolean {
  mkdirSync(path.dirname(at), { recursive: true });
  try {
    symlinkSync(target, at);
    return true;
  } catch (e) {
    if (process.platform !== "win32") throw e;
    return false;
  }
}

/** Every Plan 1 fixture in the home; per P0 tool, files that its readers read. */
function buildAll(): Record<string, string[]> {
  const cc = buildCcTranscripts(h);
  buildCcLifetime(h);
  const rollouts = buildCodexRollouts(h);
  const index = buildCodexIndex(h);
  const copilot = buildCopilot(h);
  const cursor = buildCursor(h);
  const agentCli = buildAgentCli(h);
  const antigravity = buildAntigravity(h);
  return {
    "claude-code": cc.readFiles.map((rel) => path.join(h.env.home, rel)),
    codex: [...rollouts.files, ...Object.values(index.files)],
    copilot: [copilot.journalFile, copilot.legacyFile],
    cursor: [cursor.globalFile, cursor.trackingFile, ...agentCli.files],
    antigravity: [antigravity.summariesFile, antigravity.stepsFile, antigravity.ideFile],
  };
}

describe("never-opened files", () => {
  test("a scan of every P0 source opens no credential, token or key file, and nothing outside the home", async () => {
    const read = buildAll();
    // the JetBrains plugin keeps its folder in LOCALAPPDATA on Windows, under .config elsewhere
    const jetbrains = ["apps.json", "hosts.json"].map((name) => path.join(jetbrainsRel(h), name));
    for (const rel of new Set([...PLANTED.map((p) => path.normalize(p)), ...jetbrains])) h.write(rel, CANARY.secret);

    const opens = await recordOpens(() => scan({ env: h.env }));

    expect(violations(opens, h.root)).toEqual([]);
    const tools = [...new Set(registry.filter((p) => p.tier === "P0").map((p) => p.tool))].sort();
    expect(Object.keys(read).sort()).toEqual(tools);
    const opened = new Set(opens.map((o) => real(o.path)));
    expect(tools.map((t) => [t, read[t]!.some((f) => opened.has(real(f)))])).toEqual(tools.map((t) => [t, true]));
  });

  test("the check sees through links: a file read through a link counts as the file behind it", async () => {
    const auth = h.write(".codex/auth.json", `${JSON.stringify({ token: CANARY.secret })}\n`);
    const outside = mkdtempSync(path.join(os.tmpdir(), "never-opened-outside-"));
    try {
      const elsewhere = path.join(outside, "history.jsonl");
      writeFileSync(elsewhere, `${JSON.stringify({ display: "hi", timestamp: Date.now() - 60_000 })}\n`);
      // links where the history readers look: one to a never-opened file, one to a file outside the home
      if (!link(auth, path.join(h.env.home, ".codex", "history.jsonl"))) return;
      if (!link(elsewhere, path.join(h.env.home, ".claude", "history.jsonl"))) return;

      const opens = await recordOpens(() => scan({ env: h.env, tools: ["codex", "claude-code"] }));

      const found = violations(opens, h.root);
      expect(found).toContain(`stream ${real(auth)}: never opened`);
      expect(found).toContain(`stream ${real(elsewhere)}: outside the home`);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("the open observer: every core/io primitive reports the file it opens", () => {
  test("a JSONL stream, a small JSON read and text lines: the file as opened; a missing or too large file is never opened", async () => {
    const jsonl = h.writeJsonl("a.jsonl", [{ a: 1 }]);
    const json = h.writeJson("b.json", { b: 1 });
    const toml = h.write("c.toml", "[x]\n");
    const missing = path.join(h.env.home, "missing.json");
    const opens = await recordOpens(async () => {
      for await (const _ of readJsonl(jsonl)) { /* drain */ }
      for await (const _ of readJsonl(missing)) { /* nothing there */ }
      readJsonSmall(json);
      readJsonSmallResult(missing);
      readJsonSmallResult(json, 1); // too large: refused before it is opened
      for await (const _ of readTextLines(toml, { maxBytes: 1024 })) { /* drain */ }
    });
    expect(opens).toEqual([{ path: jsonl, how: "stream" }, { path: json, how: "read" }, { path: toml, how: "stream" }]);
  });

  test("an SQLite store: its header, then the store; a busy one, then each file copied and the private copy", async () => {
    const store = h.sqlite("s.db", ["CREATE TABLE t (x)"], { t: [[1]] });
    const temp = new TempRegistry(h.env.tmp);
    const holder = new Database(store);
    try {
      const plain = await recordOpens(() => openRo(store, temp)?.close());
      expect(plain).toEqual([{ path: store, how: "header" }, { path: store, how: "sqlite" }]);

      holder.exec("BEGIN EXCLUSIVE"); // readers get SQLITE_BUSY: openRo falls back to a private copy
      let copied: boolean | undefined;
      const busy = await recordOpens(() => {
        const db = openRo(store, temp);
        copied = db?.copied;
        db?.close();
      });
      expect(copied).toBe(true);
      expect(busy.slice(0, 3)).toEqual([{ path: store, how: "header" }, { path: store, how: "sqlite" }, { path: store, how: "copy" }]);
      expect(busy.slice(3).map((o) => [o.how, path.basename(o.path), o.path.startsWith(h.env.tmp + path.sep)])).toEqual([["sqlite", "s.db", true]]);
    } finally {
      holder.close();
      temp.disposeAll();
    }
  });

  test("links: a stream reports the path as given; a linked store, the target it is read by", async () => {
    const target = h.sqlite(path.join("real", "s.db"), ["CREATE TABLE t (x)"], { t: [[1]] });
    const jsonl = h.writeJsonl(path.join("real", "a.jsonl"), [{ a: 1 }]);
    const linkedStore = path.join(h.env.home, "linked.db");
    const linkedJsonl = path.join(h.env.home, "linked.jsonl");
    if (!link(target, linkedStore) || !link(jsonl, linkedJsonl)) return;
    const temp = new TempRegistry(h.env.tmp);
    try {
      const opens = await recordOpens(async () => {
        openRo(linkedStore, temp)?.close();
        for await (const _ of readJsonl(linkedJsonl)) { /* drain */ }
      });
      expect(opens).toEqual([{ path: realpathSync(target), how: "header" }, { path: realpathSync(target), how: "sqlite" }, { path: linkedJsonl, how: "stream" }]);
    } finally {
      temp.disposeAll();
    }
  });
});
