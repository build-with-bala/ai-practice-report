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
  "small", "lite", "plus", "thinking", "high", "low", "coder", "chat", "vision", "exp",
]);
/** A short version number: "4", "4o", "3.5", "4.1", "2.5". */
const VERSION = /^\d{1,2}(?:\.\d{1,2})?[a-z]?$/;
/** A date or a part of one: "20250805", or the "YYYY", "MM", "DD" of "YYYY-MM-DD". */
const DATE_PART = /^(?:\d{8}|\d{4}|\d{2})$/;
const modelToken = (t: string): boolean => VERSION.test(t) || DATE_PART.test(t) || MODEL_WORDS.has(t);

/**
 * A model id as exported:
 * - "ft:…" (a fine-tuned model) → "fine-tuned";
 * - an id of a known family (`MODEL_FAMILY_PATTERN`) whose every "-"-separated token after the family is a short version
 *   number, a date part or a word of `MODEL_WORDS` → the id as is ("claude-opus-4-1-20250805", "gpt-4o-mini");
 * - another id of a known family → "<family>-other" ("gpt-4o-contoso-prod" → "gpt-other");
 * - anything else, or an id with characters other than a–z, 0–9, "." and "-", or longer than 64 → "other".
 * Ids that map to one export id have their counts summed by the caller.
 */
export function modelExportId(raw: string): string {
  if (raw.startsWith("ft:")) return "fine-tuned";
  if (!MODEL_CHARS.test(raw)) return "other";
  const m = FAMILY.exec(raw);
  if (!m) return "other";
  const family = m[0];
  const rest = raw.slice(family.length);
  if (rest === "") return family;
  if (rest.startsWith("-") && rest.slice(1).split("-").every(modelToken)) return raw;
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
