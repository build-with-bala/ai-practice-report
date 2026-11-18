import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import path from "node:path";
import { readJsonSmall, readJsonSmallResult, readTextLines } from "../../core/io/fs";
import { readJsonl } from "../../core/io/jsonl";
import { __observeOpens, isNeverOpened, NeverOpenedError, type OpenHow } from "../../core/io/observe";
import { __observeQueries, openRo } from "../../core/io/sqlite";
import { TempRegistry } from "../../core/io/temp";
import { scan, type ScanOptions, type ScanResult } from "../../core/scan";
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
/** A table that holds credentials or accounts, by its name: no statement reads one. */
const CREDENTIAL_TABLE = /account|credential|auth|token|oauth|secret/i;

interface Open { path: string; how: OpenHow }

let h: FakeHome;
beforeEach(() => {
  h = fakeHome();
});
afterEach(() => {
  __observeOpens(undefined);
  __observeQueries(undefined);
  h.cleanup();
});

/** The opens that `run` attempts, in order, as the core/io primitives report them (a refused one included). */
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

/** A scan, with the opens it attempts and the SQL statements it sends. */
async function recordScan(o: ScanOptions): Promise<{ r: ScanResult; opens: Open[]; sql: string[] }> {
  const sql: string[] = [];
  __observeQueries((s) => sql.push(s));
  try {
    let r: ScanResult | undefined;
    const opens = await recordOpens(async () => {
      r = await scan(o);
    });
    return { r: r!, opens, sql };
  } finally {
    __observeQueries(undefined);
  }
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
 * The opens that break the rules, as `<how> <path>: <rule>`: an open whose path — as opened, or the file behind a link —
 * ends like a never-opened file, or lies outside the home's root.
 */
function violations(opens: Open[], root: string): string[] {
  const roots = [root, real(root)].map((r) => r + path.sep);
  const found: string[] = [];
  for (const o of opens) {
    const both = [o.path, real(o.path)];
    if (both.some((p) => NEVER_OPENED.some((end) => p.endsWith(end)))) found.push(`${o.how} ${o.path}: never opened`);
    if (!both.every((p) => roots.some((r) => p.startsWith(r)))) found.push(`${o.how} ${o.path}: outside the home`);
  }
  return found;
}

/** The tables a statement reads from: its FROM and JOIN targets, quoted names unquoted. */
const tablesOf = (sql: string): string[] =>
  [...sql.matchAll(/\b(?:FROM|JOIN)\s+(?:"((?:[^"]|"")+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][\w$]*))/gi)]
    .map((m) => m[1]?.replace(/""/g, '"') ?? m[2] ?? m[3] ?? m[4]!);

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

async function drain(lines: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of lines) { /* drain */ }
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
  test("a scan of every P0 source opens no credential, token or key file, nothing outside the home, and reads no credential table", async () => {
    const read = buildAll();
    // the JetBrains plugin keeps its folder in LOCALAPPDATA on Windows, under .config elsewhere
    const jetbrains = ["apps.json", "hosts.json"].map((name) => path.join(jetbrainsRel(h), name));
    for (const rel of new Set([...PLANTED.map((p) => path.normalize(p)), ...jetbrains])) h.write(rel, CANARY.secret);

    const { opens, sql } = await recordScan({ env: h.env });

    expect(violations(opens, h.root)).toEqual([]); // not even attempted: a refused open is reported too
    const tools = [...new Set(registry.filter((p) => p.tier === "P0").map((p) => p.tool))].sort();
    expect(Object.keys(read).sort()).toEqual(tools);
    const opened = new Set(opens.map((o) => real(o.path)));
    expect(tools.map((t) => [t, read[t]!.some((f) => opened.has(real(f)))])).toEqual(tools.map((t) => [t, true]));
    // the SQL: no statement attaches another file, none reads a credential or account table
    expect(sql.filter((s) => /\bATTACH\b/i.test(s))).toEqual([]);
    const tables = new Set(sql.flatMap(tablesOf));
    expect([...tables].filter((t) => CREDENTIAL_TABLE.test(t))).toEqual([]);
    expect([...tables]).toEqual(expect.arrayContaining(["threads", "ItemTable", "scored_commits", "cursorDiskKV"])); // the check sees the readers' tables
  });

  test("a never-opened file that a reader reaches through a link is refused: attempted, never opened, counted unreadable", async () => {
    const auth = h.write(".codex/auth.json", `${JSON.stringify({ token: CANARY.secret })}\n`);
    const credentials = h.writeJson(".claude/.credentials.json", { token: CANARY.secret });
    const key = h.write(".codex/x.key", `[profiles.${CANARY.project}]\n`);
    const store = h.sqlite(".cursor/secret.key", ["CREATE TABLE blobs (id TEXT, data BLOB)"], { blobs: [["1", CANARY.secret]] });
    // links where the readers look: a prompt log (JSONL), settings (small JSON), config.toml (text lines), a chat store (SQLite)
    const routes: [target: string, at: string, source: string][] = [
      [auth, ".codex/history.jsonl", "codex.history"], [credentials, ".claude/settings.json", "claude-code.config"],
      [key, ".codex/config.toml", "codex.config"], [store, ".cursor/chats/p1/a1/store.db", "cursor.agent-cli"],
    ];
    for (const [target, at] of routes) if (!link(target, path.join(h.env.home, at))) return;

    const { r, opens } = await recordScan({ env: h.env, tools: ["codex", "claude-code", "cursor"] });

    // each reader attempted its file — the observer saw it, and the file behind the link —, and each attempt was refused:
    // the file counts as unreadable, and nothing was read from it
    const attempted = new Set(opens.map((o) => real(o.path)));
    expect(routes.map(([target, , source]) => [source, attempted.has(real(target))])).toEqual(routes.map(([, , source]) => [source, true]));
    expect(routes.map(([, , source]) => [source, r.coverage.find((c) => c.source === source)?.skipped]))
      .toEqual(routes.map(([, , source]) => [source, { "io-error": 1 }]));
    expect(r.store.all("prompt")).toEqual([]);
    expect(r.store.all("config").filter((c) => c.kind === "profile")).toEqual([]);
  });

  test("the check itself: an open by a never-opened name, through a link to one, or outside the home is a violation", () => {
    const auth = h.write(".codex/auth.json", "{}");
    const fine = h.write(".codex/history.jsonl", "");
    const outside = path.join(path.dirname(h.root), "elsewhere.jsonl"); // need not exist
    const opens: Open[] = [{ path: fine, how: "stream" }, { path: auth, how: "read" }, { path: outside, how: "stream" }];
    const want = [`read ${auth}: never opened`, `stream ${outside}: outside the home`];
    const linked = path.join(h.env.home, "linked.jsonl");
    if (link(auth, linked)) {
      opens.push({ path: linked, how: "stream" });
      want.push(`stream ${linked}: never opened`);
    }
    expect(violations(opens, h.root)).toEqual(want);
  });
});

describe("the refusal: no core/io primitive opens a never-opened file", () => {
  test("isNeverOpened: by name and by ending, in any case, and through a link by the file behind it; other files are not", () => {
    const yes = [...PLANTED, ".ssh/id_rsa", "Library/Keychains/login.keychain-db", "x/AUTH.JSON", "certs/server.KEY"];
    const no = [".codex/history.jsonl", ".claude/settings.json", ".codex/config.toml", "store.db", "keys.json", "monkey.txt", "x.keys", "authors.json"];
    expect(yes.filter((rel) => !isNeverOpened(path.join(h.env.home, rel)))).toEqual([]);
    expect(no.filter((rel) => isNeverOpened(path.join(h.env.home, rel)))).toEqual([]);
    const linked = path.join(h.env.home, "innocent.jsonl");
    if (link(h.write(".codex/auth.json", "{}"), linked)) expect(isNeverOpened(linked)).toBe(true);
  });

  /** The OAuth, token and secret files that AI CLIs and editors keep beside their data, by name (a pattern and an ending included). */
  const AI_CREDENTIALS = [
    "oauth_creds.json", "google_accounts.json", "mcp-oauth-tokens.json", "mcp-oauth-tokens-v2.json", "mcp-auth.json", "secrets.json",
    "credentials.toml", "sso_tokens.toml", "kiro-auth-token.json", "oauth-keys.env", "secrets.yaml", "passwords.kdbx",
  ];
  for (const name of AI_CREDENTIALS) {
    test(`${name}: never opened, in any case — the attempt is refused, and reads as unreadable`, async () => {
      const file = h.write(path.join(".tool", name), JSON.stringify({ token: CANARY.secret }));
      const upper = h.write(path.join(".tool", "upper", name.toUpperCase()), "{}");
      expect([isNeverOpened(file), isNeverOpened(upper)]).toEqual([true, true]);
      const opens = await recordOpens(() => expect(readJsonSmallResult(file)).toEqual({ ok: false, reason: "io-error" }));
      expect(opens).toEqual([{ path: file, how: "read" }]); // attempted, and refused before anything was read
    });
  }

  test("names near the credential ones are opened as usual", () => {
    const near = ["oauth_creds.jsonl", "my-secrets.json", "secrets.json.example", "mcp-oauth-tokens.txt", "mcp-oauth.json", "credentials.toml.bak", "kdbx-notes.md", "sso_tokens.json"];
    expect(near.filter((name) => isNeverOpened(path.join(h.env.home, ".tool", name)))).toEqual([]);
  });

  test("each primitive reports the attempt and refuses it: JSONL and text lines throw, a small JSON read is unreadable, a store is null", async () => {
    const auth = h.write(".codex/auth.json", `${JSON.stringify({ token: CANARY.secret })}\n`);
    const key = h.write(".codex/x.key", "[x]\n");
    const store = h.sqlite("secret.key", ["CREATE TABLE t (x)"], { t: [[CANARY.secret]] });
    const temp = new TempRegistry(h.env.tmp);
    const opens = await recordOpens(async () => {
      await expect(drain(readJsonl(auth))).rejects.toBeInstanceOf(NeverOpenedError);
      await expect(drain(readTextLines(key, { maxBytes: 1024 }))).rejects.toBeInstanceOf(NeverOpenedError);
      expect(readJsonSmallResult(auth)).toEqual({ ok: false, reason: "io-error" });
      expect(readJsonSmall(auth)).toBeUndefined();
      expect(openRo(store, temp)).toBeNull();
    });
    // nothing past each attempt: no store opened by SQLite, no private copy made
    expect(opens).toEqual([
      { path: auth, how: "stream" }, { path: key, how: "stream" }, { path: auth, how: "read" }, { path: auth, how: "read" }, { path: store, how: "header" },
    ]);
    expect(temp.active).toBe(0);
  });
});

describe("the open observer: every core/io primitive reports the file it opens", () => {
  test("a JSONL stream, a small JSON read and text lines: the file as opened; a missing or too large file is never opened", async () => {
    const jsonl = h.writeJsonl("a.jsonl", [{ a: 1 }]);
    const json = h.writeJson("b.json", { b: 1 });
    const toml = h.write("c.toml", "[x]\n");
    const missing = path.join(h.env.home, "missing.json");
    const opens = await recordOpens(async () => {
      await drain(readJsonl(jsonl));
      await drain(readJsonl(missing)); // nothing there
      readJsonSmall(json);
      readJsonSmallResult(missing);
      readJsonSmallResult(json, 1); // too large: refused before it is opened
      await drain(readTextLines(toml, { maxBytes: 1024 }));
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
        await drain(readJsonl(linkedJsonl));
      });
      expect(opens).toEqual([{ path: realpathSync(target), how: "header" }, { path: realpathSync(target), how: "sqlite" }, { path: linkedJsonl, how: "stream" }]);
    } finally {
      temp.disposeAll();
    }
  });
});
