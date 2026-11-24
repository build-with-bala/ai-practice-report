import { lstatSync, readlinkSync } from "node:fs";
import path from "node:path";

/**
 * How a core/io primitive opens a file's content: `stream` (read in chunks: JSONL, text lines), `read` (read whole: a
 * small JSON file), `sqlite` (opened by SQLite), `header` (a store's first bytes, which say its journal mode) or `copy`
 * (copied into a private temp folder: a busy store).
 */
export type OpenHow = "stream" | "read" | "sqlite" | "header" | "copy";

/**
 * Credential and token files, by name: Codex's `auth.json`, Claude Code's `.credentials.json`, Copilot's `apps.json` and
 * `hosts.json`, SSH private keys; and the OAuth, account, token and secret files other AI CLIs and editors keep beside
 * their data.
 */
const NEVER_OPENED_NAMES: ReadonlySet<string> = new Set([
  "auth.json", ".credentials.json", "apps.json", "hosts.json",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ecdsa_sk", "id_ed25519", "id_ed25519_sk",
  "oauth_creds.json", "google_accounts.json", "mcp-auth.json", "secrets.json", "credentials.toml", "sso_tokens.toml",
  "kiro-auth-token.json", "oauth-keys.env", "secrets.yaml",
]);
/** Key files, OS keychains and password databases (KeePass), by ending. */
const NEVER_OPENED_ENDINGS = [".key", ".keychain", ".keychain-db", ".kdbx"];
/** Names that vary: MCP OAuth token files (`mcp-oauth-tokens*.json`). */
const NEVER_OPENED_PATTERNS = [/^mcp-oauth-tokens.*\.json$/];

const neverOpenedName = (name: string): boolean => {
  const n = name.toLowerCase();
  return NEVER_OPENED_NAMES.has(n) || NEVER_OPENED_ENDINGS.some((end) => n.endsWith(end)) || NEVER_OPENED_PATTERNS.some((re) => re.test(n));
};

/** Links followed one by one, at most this many: a longer chain is refused (the system gives up on a loop sooner). */
const MAX_HOPS = 40;

/**
 * Whether a path leads to a file no reader may ever open — a credential, token or key file — by its own name or, for a
 * link, by the name of any link of the chain it follows and of the file it resolves to (names compare
 * case-insensitively; a chain longer than MAX_HOPS is refused too). Names are all a path shows: a hard link to such a
 * file under another name is the same file, and cannot be told apart by name — the guarantee is about names.
 */
export function isNeverOpened(p: string): boolean {
  let at = p;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (neverOpenedName(path.basename(at))) return true;
    let link: boolean;
    try {
      link = lstatSync(at).isSymbolicLink();
    } catch {
      return false; // nothing to resolve: nothing there to open either
    }
    if (!link) return false;
    try {
      at = path.resolve(path.dirname(at), readlinkSync(at));
    } catch {
      return false;
    }
  }
  return true;
}

/** A never-opened file was about to be opened (`noteOpen`), and was not. */
export class NeverOpenedError extends Error {}

let observer: ((path: string, how: OpenHow) => void) | undefined;

/**
 * Called by every core/io primitive right before it opens a file's content, with the path it opens it by. It reports the
 * open to the test hook, then refuses a never-opened file (`isNeverOpened`): NeverOpenedError, and the file is never
 * opened — the guarantee is enforced, not only tested. Only core/io opens files (a static rule pins that), so the hook
 * sees every open the engine attempts, a refused one included. A linked store is reported by the path SQLite opens
 * (`openRo` resolves the link); any other link is reported as given.
 */
export function noteOpen(p: string, how: OpenHow): void {
  observer?.(p, how);
  if (isNeverOpened(p)) throw new NeverOpenedError("a credential, token or key file is never opened");
}

/** Test hook: every open a core/io primitive attempts is reported (`noteOpen`); undefined = off. */
export function __observeOpens(fn?: (path: string, how: OpenHow) => void): void {
  observer = fn;
}
