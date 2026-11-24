import type { Analysis } from "../analyze";

/*
 * The allowlists the export reads raw channels through (spec §6.7, global constraints: free text). A raw value leaves
 * the machine only when it is on a list here; anything else becomes a fixed token ("other", "fine-tuned", "custom #n").
 * Pure and synchronous.
 */

/** MCP servers whose names are public (spec §6.7): exported by name; every other server is "custom #n". */
export const MCP_PUBLIC: ReadonlySet<string> = new Set([
  "github", "gitlab", "git", "filesystem", "fetch", "memory", "time", "sequential-thinking", "playwright", "puppeteer", "context7", "sentry",
  "linear", "atlassian", "slack", "postgres", "sqlite", "supabase", "stripe", "cloudflare", "vercel", "docker", "kubernetes", "figma", "brave-search",
]);

/**
 * The public name of an MCP server, or undefined: lower-cased, then "@scope/" and any "server-" or "mcp-" prefix and
 * "-mcp" suffix stripped (repeatedly, so "mcp-server-github" is "github"); a name on `MCP_PUBLIC`, else undefined.
 */
export function mcpExportName(raw: string): string | undefined {
  let s = raw.toLowerCase().replace(/^@[^/]*\//, "");
  for (let was = ""; was !== s;) {
    was = s;
    if (s.startsWith("server-")) s = s.slice("server-".length);
    if (s.startsWith("mcp-")) s = s.slice("mcp-".length);
    if (s.endsWith("-mcp")) s = s.slice(0, -"-mcp".length);
  }
  return MCP_PUBLIC.has(s) ? s : undefined;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The export label of each MCP server of an analysis's private config: keyed hash (`key`) → its public name
 * (`mcpExportName`), else "custom #n", numbered 1, 2, … in keyed-hash order, so the numbering says nothing about the
 * names. Only `mcp-server` entries are labelled. The export's `config.mcpServers` and B's anonymized report both use
 * it (P3 pre-flight F15).
 */
export function mcpLabels(config: Analysis["private"]["config"]): Map<string, string> {
  const out = new Map<string, string>();
  let custom = 0;
  const servers = config.filter((c) => c.kind === "mcp-server").sort((a, b) => cmp(a.key, b.key));
  for (const c of servers) {
    if (out.has(c.key)) continue;
    out.set(c.key, mcpExportName(c.name) ?? `custom #${++custom}`);
  }
  return out;
}

/** The model families whose ids may be exported (an alternation, unanchored): every other model is "other". */
export const MODEL_FAMILY_PATTERN = "claude|gpt|o\\d|gemini|codex|grok|llama|mistral|qwen|deepseek";
const FAMILY = new RegExp(`^(?:${MODEL_FAMILY_PATTERN})`);
/** The characters and length a model id may have at all; anything else (upper case, "/", whitespace, longer) is "other". */
const MODEL_CHARS = /^[a-z0-9.-]{1,64}$/;

/** The public tier and variant words a model id may hold after its family (I3: an allowlist, not a prefix). */
export const MODEL_WORDS: ReadonlySet<string> = new Set([
  "opus", "sonnet", "haiku", "mini", "nano", "pro", "flash", "ultra", "max", "turbo", "preview", "latest", "codex", "instant", "large", "medium",
  "small", "lite", "plus", "thinking", "high", "low", "coder", "chat", "vision", "exp", "fable", "mythos",
]);
/** The letters a version may end in, from public ids: "o" (gpt-4o, "omni") and "b" (a parameter count: llama-3-70b). */
export const VERSION_SUFFIXES: ReadonlySet<string> = new Set(["o", "b"]);
/**
 * A version, in the shape public ids have: 1 or 2 digits with no leading zero ("4", "12", "0"), an optional 1-digit
 * fraction ("3.5", "0.5"), and optionally the omni suffix "o" ("4o"); or a parameter count, 1 to 3 digits with the size
 * suffix "b" ("70b", "405b", "0.5b"). No other letter (`VERSION_SUFFIXES`).
 */
const VERSION = /^(?:(?:0|[1-9]\d?)(?:\.\d)?o?|(?:0|[1-9]\d{0,2})(?:\.\d)?b)$/;
/** At most this many tokens after the family, and at most this many versions among them. */
const MAX_MODEL_TOKENS = 6;
const MAX_VERSIONS = 2;

/** True when year, month and day make a real date (years 2000–2099). */
function realDate(y: number, m: number, d: number): boolean {
  if (y < 2000 || y > 2099 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}
/** True when month and day can be a real day of some year ("0613"; "0229" too). */
const realMonthDay = (m: number, d: number): boolean => realDate(2000, m, d);

/**
 * True when the tokens after a family are a public model id's: at most 6 of them, each a word of `MODEL_WORDS`, one of
 * at most 2 versions (`VERSION`), or part of the one date the id may hold, in a public form — one "YYYYMMDD" token,
 * the three tokens "YYYY", "MM", "DD" in a row, or one "MMDD" token (its leading zero kept: "0613") — with real month
 * and day ranges.
 */
function publicTokens(tokens: readonly string[]): boolean {
  if (tokens.length > MAX_MODEL_TOKENS) return false;
  let dates = 0;
  let versions = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (VERSION.test(t)) {
      if (++versions > MAX_VERSIONS) return false;
      continue;
    }
    if (MODEL_WORDS.has(t)) continue;
    let date = false;
    if (/^\d{8}$/.test(t)) date = realDate(+t.slice(0, 4), +t.slice(4, 6), +t.slice(6, 8));
    else if (/^\d{4}$/.test(t) && /^\d{2}$/.test(tokens[i + 1] ?? "") && /^\d{2}$/.test(tokens[i + 2] ?? "")
      && realDate(+t, +tokens[i + 1]!, +tokens[i + 2]!)) {
      date = true;
      i += 2;
    } else if (/^\d{4}$/.test(t)) date = realMonthDay(+t.slice(0, 2), +t.slice(2, 4));
    if (!date || ++dates > 1) return false;
  }
  return true;
}

/**
 * The two public cloud forms of a model id: Amazon Bedrock's, an optional region word ("us.", "eu.", "apac."…), then
 * "anthropic.", the id, then "-v<N>:<N>"; and Google Vertex AI's, the id then "@" and a real date "YYYYMMDD".
 */
const BEDROCK = /^(?:[a-z]{2,8}\.)?anthropic\.([a-z0-9.-]+)-v\d{1,3}:\d{1,3}$/;
const VERTEX = /^([a-z0-9.-]+)@(\d{4})(\d{2})(\d{2})$/;

/** The plain id of a cloud form (`BEDROCK`, `VERTEX`), else `raw` itself: the grammar then runs on the plain id. */
function plainId(raw: string): string {
  const b = BEDROCK.exec(raw);
  if (b) return b[1]!;
  const v = VERTEX.exec(raw);
  if (v && realDate(+v[2]!, +v[3]!, +v[4]!)) return v[1]!;
  return raw;
}

/**
 * A model id as exported. The rule guards against the ACCIDENTAL disclosure of a deployment or customer name riding on
 * a public family prefix ("gpt-4o-contoso-prod"); it is not a defence against a person who deliberately encodes data in
 * their own model ids — they control their own machine and their own export. A list of every public version was
 * rejected: each new model would read "<family>-other" until the tool is updated; the shape rules below are used instead.
 * - "ft:…" (a fine-tuned model) → "fine-tuned";
 * - a cloud form ("us.anthropic.claude-sonnet-4-20250514-v1:0", "claude-opus-4-1@20250805") is first reduced to its
 *   plain id (`plainId`), and the rules below run on that;
 * - an id of a known family (`MODEL_FAMILY_PATTERN`) whose "-"-separated tokens after the family pass `publicTokens`
 *   (at most 6 tokens: `MODEL_WORDS` words, at most 2 versions and one real date) → the id as is ("claude-opus-4-1-20250805", "gpt-4o-mini");
 * - another id of a known family → "<family>-other" ("gpt-4o-contoso-prod" → "gpt-other");
 * - anything else, or an id with characters other than a–z, 0–9, "." and "-", or longer than 64 → "other".
 * Ids that map to one export id have their counts summed by the caller.
 */
export function modelExportId(id: string): string {
  if (id.startsWith("ft:")) return "fine-tuned";
  const raw = plainId(id);
  if (!MODEL_CHARS.test(raw)) return "other";
  const m = FAMILY.exec(raw);
  if (!m) return "other";
  const family = m[0];
  const rest = raw.slice(family.length);
  if (rest === "") return family;
  if (rest.startsWith("-") && publicTokens(rest.slice(1).split("-"))) return raw;
  return `${family}-other`;
}

/**
 * The risk-posture tokens the readers know (their own allowlists map everything else to "other"): Claude Code
 * permission modes, Codex approval policies and sandbox modes. The export keeps these and folds any other into "other".
 */
export const RISK_TOKENS = {
  permission: ["default", "acceptEdits", "plan", "auto", "bypassPermissions"],
  approval: ["untrusted", "on-failure", "on-request", "granular", "never"],
  sandbox: ["read-only", "workspace-write", "danger-full-access", "external-sandbox", "disabled", "managed"],
} as const satisfies Record<"permission" | "approval" | "sandbox", readonly string[]>;

/** A risk-posture token as exported: a known one, else "other". */
export function riskExportToken(kind: keyof typeof RISK_TOKENS, raw: string): string {
  return (RISK_TOKENS[kind] as readonly string[]).includes(raw) ? raw : "other";
}
